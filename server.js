const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash
} = require("node:crypto");
const storage = require("./storage");

const ROOT = __dirname;
const HOST = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY_BYTES = 1_000_000;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;
const ADMIN_USERNAME = process.env.QUIZ_ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.QUIZ_ADMIN_PASSWORD;
const COOKIE_SECURE = process.env.QUIZ_COOKIE_SECURE === "true";
const adminSessions = new Map();
const loginAttempts = new Map();

if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) {
  console.error("Set QUIZ_ADMIN_PASSWORD to a strong password of at least 12 characters before starting Quiztron.");
  process.exit(1);
}

const ADMIN_USERNAME_HASH = createHash("sha256").update(ADMIN_USERNAME).digest();
const ADMIN_PASSWORD_HASH = scryptSync(ADMIN_PASSWORD, "quiztron-admin-v1", 64);

if (process.env.NODE_ENV === "production" && !process.env.DATABASE_URL) {
  console.error("Set DATABASE_URL to a persistent PostgreSQL database before starting Quiztron in production.");
  process.exit(1);
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(value));
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

function secureEqual(left, right) {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map(cookie => {
    const separator = cookie.indexOf("=");
    if (separator < 0) return ["", ""];
    return [cookie.slice(0, separator).trim(), cookie.slice(separator + 1).trim()];
  }).filter(([name]) => name));
}

function sessionCookie(token, request) {
  const secure = COOKIE_SECURE || request.socket.encrypted;
  return [
    `quiztron_admin=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    secure ? "Secure" : ""
  ].filter(Boolean).join("; ");
}

function clearSessionCookie(request) {
  const secure = COOKIE_SECURE || request.socket.encrypted;
  return [
    "quiztron_admin=",
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
    secure ? "Secure" : ""
  ].filter(Boolean).join("; ");
}

function getAdminSession(request) {
  const token = parseCookies(request.headers.cookie).quiztron_admin;
  if (!token) return null;
  const session = adminSessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    adminSessions.delete(token);
    return null;
  }
  return session;
}

function requestIp(request) {
  return request.socket.remoteAddress || "unknown";
}

function enforceSameOrigin(request, response) {
  const origin = request.headers.origin;
  const secure = COOKIE_SECURE || request.socket.encrypted;
  try {
    const parsedOrigin = new URL(origin);
    if (parsedOrigin.host === request.headers.host &&
        parsedOrigin.protocol === (secure ? "https:" : "http:")) return true;
  } catch {
    // Missing and invalid Origin headers are rejected below.
  }
  sendError(response, 403, "This request must come from the same Quiztron address.");
  return false;
}

function authenticateAdmin(request, response) {
  if (getAdminSession(request)) return true;
  sendError(response, 401, "Please sign in to access the admin dashboard.");
  return false;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    request.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooLarge) {
        reject(Object.assign(new Error("Request body is too large."), { status: 413 }));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("Request body must be valid JSON."), { status: 400 }));
      }
    });
    request.on("error", reject);
  });
}

function validateRounds(rounds) {
  if (!Array.isArray(rounds) || rounds.length !== 3) {
    return "The quiz must contain exactly three rounds.";
  }
  for (const [roundIndex, round] of rounds.entries()) {
    if (!round || typeof round.title !== "string" || !round.title.trim() || round.title.length > 100) {
      return `Round ${roundIndex + 1} needs a title of 1–100 characters.`;
    }
    if (!Number.isInteger(round.timeLimit) || round.timeLimit < 60 || round.timeLimit > 3600) {
      return `Round ${roundIndex + 1} must have a time limit between 1 and 60 minutes.`;
    }
    if (!Number.isInteger(round.marks) || round.marks < 1 || round.marks > 100) {
      return `Round ${roundIndex + 1} must award between 1 and 100 marks per correct answer.`;
    }
    if (typeof round.level !== "string" || round.level.length > 40) {
      return `Round ${roundIndex + 1} needs a level label of at most 40 characters.`;
    }
    if (!Array.isArray(round.questions) || round.questions.length < 1 || round.questions.length > 50) {
      return `Round ${roundIndex + 1} must contain between 1 and 50 questions.`;
    }
    for (const [questionIndex, question] of round.questions.entries()) {
      if (!question || typeof question.question !== "string" || !question.question.trim() || question.question.length > 500) {
        return `Round ${roundIndex + 1}, question ${questionIndex + 1} needs text of 1–500 characters.`;
      }
      if (!Array.isArray(question.options) || question.options.length !== 4 ||
          question.options.some(option => typeof option !== "string" || !option.trim() || option.length > 200)) {
        return `Round ${roundIndex + 1}, question ${questionIndex + 1} needs four options of 1–200 characters.`;
      }
      if (!Number.isInteger(question.answer) || question.answer < 0 || question.answer > 3) {
        return `Round ${roundIndex + 1}, question ${questionIndex + 1} needs one correct option.`;
      }
    }
  }
  return null;
}

function publicRounds(rounds) {
  return rounds.map(({ title, timeLimit, marks, level, questions }) => ({
    title,
    timeLimit,
    marks,
    level,
    questions: questions.map(({ question, options }) => ({ question, options }))
  }));
}

async function handleApi(request, response, pathname) {
  if (request.method === "GET" && pathname === "/api/admin/session") {
    return sendJson(response, 200, { authenticated: Boolean(getAdminSession(request)) });
  }

  if (request.method === "POST" && pathname === "/api/admin/login") {
    if (!enforceSameOrigin(request, response)) return;
    const ip = requestIp(request);
    const attempt = loginAttempts.get(ip);
    if (attempt?.blockedUntil > Date.now()) {
      response.setHeader("Retry-After", String(Math.ceil((attempt.blockedUntil - Date.now()) / 1000)));
      return sendError(response, 429, "Too many sign-in attempts. Wait 15 minutes and try again.");
    }

    const body = await readBody(request);
    const username = typeof body?.username === "string" ? body.username : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (username.length > 200 || password.length > 1024) {
      return sendError(response, 401, "Incorrect username or password.");
    }
    const usernameMatches = secureEqual(username, ADMIN_USERNAME);
    const passwordHash = scryptSync(password, "quiztron-admin-v1", 64);
    const passwordMatches = timingSafeEqual(passwordHash, ADMIN_PASSWORD_HASH);

    if (!usernameMatches || !passwordMatches) {
      const current = loginAttempts.get(ip);
      const failures = (current?.windowStartedAt > Date.now() - LOGIN_WINDOW_MS ? current.failures : 0) + 1;
      loginAttempts.set(ip, {
        failures,
        windowStartedAt: current?.windowStartedAt > Date.now() - LOGIN_WINDOW_MS ? current.windowStartedAt : Date.now(),
        blockedUntil: failures >= MAX_LOGIN_FAILURES ? Date.now() + LOGIN_WINDOW_MS : 0
      });
      return sendError(response, 401, "Incorrect username or password.");
    }

    loginAttempts.delete(ip);
    const token = randomBytes(32).toString("base64url");
    adminSessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });
    response.setHeader("Set-Cookie", sessionCookie(token, request));
    return sendJson(response, 200, { authenticated: true });
  }

  if (request.method === "POST" && pathname === "/api/admin/logout") {
    if (!enforceSameOrigin(request, response)) return;
    const token = parseCookies(request.headers.cookie).quiztron_admin;
    if (token) adminSessions.delete(token);
    response.setHeader("Set-Cookie", clearSessionCookie(request));
    return sendJson(response, 200, { authenticated: false });
  }

  if (request.method === "GET" && pathname === "/api/quiz") {
    const rounds = await storage.getRounds();
    return sendJson(response, 200, { rounds: publicRounds(rounds) });
  }

  if (request.method === "GET" && pathname === "/api/admin") {
    if (!authenticateAdmin(request, response)) return;
    return sendJson(response, 200, await storage.getAdminData());
  }

  if (request.method === "PUT" && pathname === "/api/admin/rounds") {
    if (!enforceSameOrigin(request, response) || !authenticateAdmin(request, response)) return;
    const body = await readBody(request);
    const error = validateRounds(body?.rounds);
    if (error) return sendError(response, 400, error);
    await storage.saveRounds(body.rounds);
    return sendJson(response, 200, { rounds: body.rounds });
  }

  if (request.method === "POST" && pathname === "/api/sessions") {
    const body = await readBody(request);
    const participant = typeof body?.name === "string" ? body.name.trim() : "";
    if (!participant || participant.length > 60) {
      return sendError(response, 400, "Enter a participant name of 1–60 characters.");
    }
    const rounds = await storage.getRounds();
    const sessionId = await storage.createSession(participant, rounds.length);
    return sendJson(response, 201, { sessionId });
  }

  const submitMatch = pathname.match(/^\/api\/sessions\/([0-9a-f-]{36})\/rounds\/(\d+)$/i);
  if (request.method === "POST" && submitMatch) {
    const [, sessionId, roundText] = submitMatch;
    const roundIndex = Number(roundText);
    const body = await readBody(request);
    const rounds = await storage.getRounds();
    const round = rounds[roundIndex];
    if (!round) return sendError(response, 404, "Quiz round not found.");
    if (!Array.isArray(body?.answers) || body.answers.length !== round.questions.length ||
        body.answers.some(answer => answer !== null && (!Number.isInteger(answer) || answer < 0 || answer > 3))) {
      return sendError(response, 400, "Answers must contain one valid choice or blank for each question.");
    }

    const submitted = await storage.submitRound(
      sessionId,
      roundIndex,
      body.answers,
      body.timeExpired === true,
      rounds
    );
    const { correct, score, timeExpired } = submitted.result;
    return sendJson(response, 200, {
      result: { correct, score, timeExpired },
      totalScore: submitted.totalScore,
      status: submitted.status
    });
  }

  sendError(response, 404, "API endpoint not found.");
}

function servePage(response, pathname) {
  const pages = new Map([
    ["/", "index.html"],
    ["/index.html", "index.html"],
    ["/admin", "admin.html"],
    ["/admin.html", "admin.html"]
  ]);
  const filename = pages.get(pathname);
  if (!filename) return sendError(response, 404, "Page not found.");
  const contents = fs.readFileSync(path.join(ROOT, filename));
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'"
  });
  response.end(contents);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${HOST}:${PORT}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url.pathname);
    } else if (request.method === "GET") {
      servePage(response, url.pathname);
    } else {
      sendError(response, 405, "Method not allowed.");
    }
  } catch (error) {
    if (!response.headersSent && !response.destroyed) {
      sendError(response, error.status || 500, error.status ? error.message : "The server could not complete the request.");
    } else if (!response.destroyed) {
      response.destroy(error);
    }
    if (!error.status) console.error(error);
  }
});

async function startServer() {
  await storage.initialize(fs.existsSync(path.join(ROOT, "data", "rounds.json"))
    ? JSON.parse(fs.readFileSync(path.join(ROOT, "data", "rounds.json"), "utf8"))
    : []);
  server.listen(PORT, HOST, () => {
    console.log(`Quiztron is listening on ${HOST}:${PORT}`);
    console.log(`Storage: ${storage.usesDatabase ? "PostgreSQL" : "local JSON files"}`);
  });
}

async function shutdown() {
  server.close(async () => {
    await storage.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

startServer().catch(error => {
  console.error("Quiztron could not initialize storage:", error);
  process.exit(1);
});
