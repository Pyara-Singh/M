function integer(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

function loadConfig() {
  const config = {
    port: integer("PORT", 3001, 1, 65535),
    rtcMinPort: integer("RTC_MIN_PORT", 40000, 1024, 65535),
    rtcMaxPort: integer("RTC_MAX_PORT", 49999, 1024, 65535),
    listenIp: process.env.LISTEN_IP || "0.0.0.0",
    announcedIp: process.env.ANNOUNCED_IP || "127.0.0.1",
    joinTokenSecret: process.env.JOIN_TOKEN_SECRET || "",
    origins: (process.env.CORS_ORIGINS || "http://localhost:5173,http://127.0.0.1:5173").split(",").map(value => value.trim()).filter(Boolean)
  };
  if (config.rtcMinPort > config.rtcMaxPort) throw new Error("RTC_MIN_PORT must not exceed RTC_MAX_PORT");
  if (!config.origins.length || config.origins.includes("*")) throw new Error("CORS_ORIGINS must list allowed origins");
  if (config.joinTokenSecret && config.joinTokenSecret.length < 32) throw new Error("JOIN_TOKEN_SECRET must contain at least 32 characters");
  if (process.env.NODE_ENV === "production" && !config.joinTokenSecret) throw new Error("JOIN_TOKEN_SECRET is required in production");
  return config;
}

module.exports = { loadConfig };
