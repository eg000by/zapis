/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Самодостаточная сборка для Docker (server.js + минимальные node_modules).
  // Vercel этот параметр игнорирует — деплой на Vercel не меняется.
  output: "standalone",
};

module.exports = nextConfig;
