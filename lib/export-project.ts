import type { FileData } from "@/types/workspace";

// Base dependencies bundled into every export (mirrors CodePanel).
export const BASE_DEPENDENCIES: Record<string, string> = {
  "react-is": "latest",
  "react-router-dom": "latest",
  "lucide-react": "latest",
  recharts: "latest",
  "date-fns": "latest",
  "framer-motion": "latest",
  "react-hook-form": "latest",
  "@hookform/resolvers": "latest",
  zod: "latest",
  "@radix-ui/react-dialog": "latest",
  "@radix-ui/react-dropdown-menu": "latest",
  "@radix-ui/react-tabs": "latest",
  "@radix-ui/react-tooltip": "latest",
  "@radix-ui/react-accordion": "latest",
  "@radix-ui/react-select": "latest",
  axios: "latest",
  clsx: "latest",
  "class-variance-authority": "latest",
  "tailwind-merge": "latest",
};

export const GITIGNORE_CONTENT = `node_modules/
.env
.env.local
.env.production
.next/
dist/
build/
.DS_Store
`;

export const ENV_EXAMPLE_CONTENT = `# Drevo-generated app - copy to .env and fill in real values.
# Never commit real secrets.
# API_KEY=
# DATABASE_URL=
`;

export interface ProjectFileInput {
  files: Record<string, { code: string }>;
  dependencies?: Record<string, string>;
  title?: string | null;
}

function toRepoPath(filePath: string): string {
  return filePath.startsWith("/") ? `src${filePath}` : `src/${filePath}`;
}

/**
 * Single source of truth for project exports.
 * Used by both the ZIP download and the GitHub push so they cannot drift.
 * Returns a map of repo-relative path -> file content.
 */
export function buildProjectFiles(input: ProjectFileInput): Record<string, string> {
  const { files, dependencies: extraDeps, title } = input;
  const dependencies = { ...BASE_DEPENDENCIES, ...(extraDeps ?? {}) };

  const packageJson = {
    name: "drevo-app",
    version: "1.0.0",
    private: true,
    dependencies: {
      react: "^18.2.0",
      "react-dom": "^18.2.0",
      "react-scripts": "5.0.1",
      ...dependencies,
    },
    scripts: {
      start: "react-scripts start",
      build: "react-scripts build",
    },
    browserslist: {
      production: [">0.2%", "not dead", "not op_mini all"],
      development: ["last 1 chrome version"],
    },
  };

  const out: Record<string, string> = {};
  out["package.json"] = JSON.stringify(packageJson, null, 2);
  out["public/index.html"] = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Drevo App</title>
    <script src="https://cdn.tailwindcss.com"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;

  for (const [filePath, fileObj] of Object.entries(files)) {
    const code =
      typeof fileObj === "object" && fileObj !== null && "code" in fileObj
        ? (fileObj as { code: string }).code
        : "";
    out[toRepoPath(filePath)] = code;
  }

  out["src/index.js"] = `import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<React.StrictMode><App /></React.StrictMode>);`;

  const displayTitle = title ?? "Drevo App";
  out["README.md"] =
    `# ${displayTitle}\n\nGenerated with [Drevo](https://drevo.app).\n\n## Getting started\n\n\`\`\`bash\nnpm install\nnpm start\n\`\`\``;

  out[".gitignore"] = GITIGNORE_CONTENT;
  out[".env.example"] = ENV_EXAMPLE_CONTENT;

  return out;
}

export function buildProjectFilesFromFileData(
  fileData: FileData,
  appTitle?: string | null
): Record<string, string> {
  return buildProjectFiles({
    files: fileData.files ?? {},
    dependencies: fileData.dependencies ?? {},
    title: appTitle ?? fileData.title ?? null,
  });
}

export function exportZipName(appTitle: string | null): string {
  return appTitle
    ? `${appTitle
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")}.zip`
    : "drevo-app.zip";
}
