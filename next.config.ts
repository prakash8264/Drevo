import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
   serverExternalPackages: [
    "@cline/sdk",
    "@cline/core",
    "@cline/agents",
    "@cline/llms",
    "@cline/shared",
  ],
};

export default nextConfig;
