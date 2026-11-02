const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { Pool } = require("pg");

const DATA_DIR = path.join(__dirname, "data");
const ROUNDS_FILE = path.join(DATA_DIR, "rounds.json");
const RESULTS_FILE = path.join(DATA_DIR, "results.json");
const DATABASE_URL = process.env.DATABASE_URL;
const USE_DATABASE = Boolean(DATABASE_URL);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function saveJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}

function connectionStringWithoutSslOverrides(value) {
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("DATABASE_URL must be a PostgreSQL connection URL.");
  }
  for (const parameter of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) {
    url.searchParams.delete(parameter);
  }
  return url.toString();
}

if (USE_DATABASE && process.env.NODE_ENV === "production" && process.env.DATABASE_SSL === "false") {
  throw new Error("DATABASE_SSL=false is not allowed in production.");
}

const pool = USE_DATABASE
  ? new Pool({
      connectionString: connectionStringWithoutSslOverrides(DATABASE_URL),
      ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: true },
      max: 5,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000
    })
  : null;

if (pool) {
  pool.on("error", error => {
    console.error("Unexpected PostgreSQL connection error:", error);
  });
}

class StorageError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function totalScore(session) {
  return session.roundResults.reduce((sum, result) => sum + (result?.score || 0), 0);
}

function buildRoundResult(round, answers, timeExpired) {
  const correct = answers.reduce((count, answer, index) =>
    count + (answer === round.questions[index].answer ? 1 : 0), 0);
  return {
    correct,
    score: correct * round.marks,
    timeExpired,
    review: round.questions.map((question, index) => ({
      selected: answers[index],
      correctAnswer: question.answer,
      isCorrect: answers[index] === question.answer
    }))
  };
}

async function initialize(seedRounds) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(RESULTS_FILE)) saveJson(RESULTS_FILE, []);
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS quiz_config (
      id SMALLINT PRIMARY KEY CHECK (id = 1),
      rounds JSONB NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quiz_sessions (
      id UUID PRIMARY KEY,
      participant TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL,
      finished_at TIMESTAMPTZ,
      status TEXT NOT NULL CHECK (status IN ('in-progress', 'complete')),
      round_results JSONB NOT NULL
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS quiz_sessions_started_at_idx
    ON quiz_sessions (started_at DESC)
  `);
  await pool.query(
    "INSERT INTO quiz_config (id, rounds) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING",
    [JSON.stringify(seedRounds)]
  );

}

async function getRounds() {
  if (!pool) return readJson(ROUNDS_FILE);
  const { rows } = await pool.query("SELECT rounds FROM quiz_config WHERE id = 1");
  if (!rows.length) throw new Error("Quiz rounds have not been initialized in the database.");
  return rows[0].rounds;
}

async function getAdminData() {
  if (!pool) {
    return { rounds: readJson(ROUNDS_FILE), sessions: readJson(RESULTS_FILE) };
  }

  const [roundsResult, sessionsResult] = await Promise.all([
    pool.query("SELECT rounds FROM quiz_config WHERE id = 1"),
    pool.query(`
      SELECT id, participant, started_at, finished_at, status, round_results
      FROM quiz_sessions
      ORDER BY started_at DESC
    `)
  ]);
  if (!roundsResult.rows.length) throw new Error("Quiz rounds have not been initialized in the database.");
  return {
    rounds: roundsResult.rows[0].rounds,
    sessions: sessionsResult.rows.map(row => ({
      id: row.id,
      participant: row.participant,
      startedAt: row.started_at.toISOString(),
      finishedAt: row.finished_at?.toISOString() ?? null,
      status: row.status,
      roundResults: row.round_results
    }))
  };
}

async function saveRounds(rounds) {
  if (!pool) {
    saveJson(ROUNDS_FILE, rounds);
    return;
  }
  await pool.query("UPDATE quiz_config SET rounds = $1::jsonb WHERE id = 1", [JSON.stringify(rounds)]);
}

async function createSession(participant, roundCount) {
  const session = {
    id: randomUUID(),
    participant,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: "in-progress",
    roundResults: Array(roundCount).fill(null)
  };

  if (!pool) {
    const sessions = readJson(RESULTS_FILE);
    sessions.unshift(session);
    saveJson(RESULTS_FILE, sessions);
    return session.id;
  }

  await pool.query(
    `INSERT INTO quiz_sessions (id, participant, started_at, status, round_results)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [session.id, session.participant, session.startedAt, session.status, JSON.stringify(session.roundResults)]
  );
  return session.id;
}

async function submitRound(sessionId, roundIndex, answers, timeExpired, rounds) {
  if (!pool) {
    const sessions = readJson(RESULTS_FILE);
    const session = sessions.find(item => item.id === sessionId);
    if (!session) throw new StorageError(404, "Quiz session not found.");
    const expectedRound = session.roundResults.findIndex(result => result === null);
    if (session.status === "complete" || roundIndex < expectedRound) {
      const savedResult = session.roundResults[roundIndex];
      const sameAnswers = savedResult?.review?.every((answer, index) => answer.selected === answers[index]);
      if (!sameAnswers) throw new StorageError(409, "This round has already been submitted with different answers.");
      return { result: savedResult, totalScore: totalScore(session), status: session.status };
    }
    if (roundIndex !== expectedRound) throw new StorageError(409, "Submit quiz rounds in order.");

    const result = buildRoundResult(rounds[roundIndex], answers, timeExpired);
    session.roundResults[roundIndex] = result;
    if (session.roundResults.every(item => item !== null)) {
      session.status = "complete";
      session.finishedAt = new Date().toISOString();
    }
    saveJson(RESULTS_FILE, sessions);
    return { result, totalScore: totalScore(session), status: session.status };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "SELECT id, status, round_results FROM quiz_sessions WHERE id = $1 FOR UPDATE",
      [sessionId]
    );
    if (!rows.length) throw new StorageError(404, "Quiz session not found.");

    const session = {
      id: rows[0].id,
      status: rows[0].status,
      roundResults: rows[0].round_results
    };
    const expectedRound = session.roundResults.findIndex(result => result === null);
    if (session.status === "complete" || roundIndex < expectedRound) {
      const savedResult = session.roundResults[roundIndex];
      const sameAnswers = savedResult?.review?.every((answer, index) => answer.selected === answers[index]);
      if (!sameAnswers) throw new StorageError(409, "This round has already been submitted with different answers.");
      await client.query("COMMIT");
      return { result: savedResult, totalScore: totalScore(session), status: session.status };
    }
    if (roundIndex !== expectedRound) throw new StorageError(409, "Submit quiz rounds in order.");

    const result = buildRoundResult(rounds[roundIndex], answers, timeExpired);
    session.roundResults[roundIndex] = result;
    if (session.roundResults.every(item => item !== null)) session.status = "complete";
    await client.query(
      `UPDATE quiz_sessions
       SET round_results = $1::jsonb,
           status = $2,
           finished_at = CASE WHEN $2 = 'complete' THEN NOW() ELSE finished_at END
       WHERE id = $3`,
      [JSON.stringify(session.roundResults), session.status, session.id]
    );
    await client.query("COMMIT");
    return { result, totalScore: totalScore(session), status: session.status };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function close() {
  if (pool) await pool.end();
}

module.exports = {
  StorageError,
  close,
  createSession,
  getAdminData,
  getRounds,
  initialize,
  saveRounds,
  submitRound,
  usesDatabase: USE_DATABASE
};
