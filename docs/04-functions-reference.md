# 04 — Functions reference (which function does what)

## Generation API — `app/api/gen-ai-code/route.ts`

- `sseEvent(type, payload)` — formats `data: JSON\n\n` SSE chunk.
- `extractThoughtLabel(text)` — pulls `**Bold**` heading or first sentence (8–80 chars) from Gemini thought for compact status steps.
- `validateDependencies(deps)` — `Promise.all fetch registry.npmjs.org/<pkg>/latest` with 1.5s timeout; keeps only `res.ok`, silently drops hallucinated packages.
- `trimHistory(messages)` — if >10, keeps `[first, ...last8]` to bound tokens.
- `buildContents(messages, fileData)` — maps `user->user / assistant->model`; appends image hint `[attached image URL...]`; on last user msg appends `Current project files: JSON(fileData)`.
- `POST(request)` — 401 if no `clerkId`, 400 if no messages, 404 if DB user missing, 402 if credits < 1. Then `ReadableStream.start{ safeEnqueue/safeClose, abort listener }`:
  1. `ai.models.generateContentStream({model: gemini-3.5-flash, systemInstruction: SYSTEM_PROMPT, temperature 0.7, responseMimeType application/json, thinkingConfig.includeThoughts})`
  2. `thought -> status` (throttled 600ms), text -> `accumulated` JSON.
  3. `JSON.parse(accumulated)` else `error invalid JSON` + return (finally closes once).
  4. Missing `files` -> `error` + return.
  5. `status Validating packages…` -> `validateDependencies` -> `newFileData`.
  6. `status Saving…` -> `db.$transaction([workspace.update|create, user.decrement])` -> re-read credits -> `done{workspaceId, assistantMessage, fileData, creditsRemaining}`.
  7. `catch` -> `isQuotaError ? error QUOTA_EXCEEDED : error generic`. `finally safeClose`.
- `isQuotaError(err)`, `getQuotaRetryAfter(msg)`, `quotaErrorPayload(err)` — detect `quota/429/resource exhausted`, parse `retry in Xs`, build `{message, code: QUOTA_EXCEEDED, retryAfter?}`.

`SYSTEM_PROMPT` enforces exact JSON `{assistantMessage, title, files{/App.js...}, dependencies}` + React/Tailwind rules + `/App.js` default export.

## Improve API — `app/api/improve/route.ts`

- Same `sseEvent` + quota helpers.
- `POST` — 401/404 as above, 400 if missing fields, 402 if no credits (all plans, 1 credit).
- `update_file.execute({path, code, reason})` — `patchedFiles[path]={code}`, `safeEnqueue(file_patch{path,code,reason})`, returns confirmation.
- `add_dependency.execute({package, version})` — accumulates into `patchedDependencies`, validated against npm before save.
- `done_improving.execute({summary})` — sets `finalSummary`, `lifecycle.completesRun:true` stops agent loop.
- `agent.subscribe(event)` — `assistant-text-delta -> thinking{text}`, `tool-started update_file/add_dependency/done_improving -> thinking{…}`.
- `agent.run(imageNote + historyBlock + userRequest)` with `systemPrompt` (fileContext dump + installed deps + batched-tool WORKFLOW + RULES), `maxIterations: 12`, `completionPolicy.requireCompletionTool`. `failed -> throw`. `max_iterations` with changed files -> partial save via shared `finishRun(note, partial:true)` (deducts 1 credit, `done` carries `partial:true`); with no changes -> friendly `MAX_ITERATIONS` SSE error, no deduction. Then validate deps + transaction saves `messages + fileData` + `done{fileData, summary, partial, creditsRemaining}`. Catch maps quota same as above.

## Actions

- `getWorkspaceUser()` — `auth()` -> `db.user findUnique(clerkId, id/credits/plan)` else `redirect("/")`.
- `getWorkspaceById(id, userId)` — `findUnique({id,userId})` else redirect.
- `getUserProjects()` — finds DB user by `clerkId`, lists workspaces desc, derives `firstPrompt` from first `role=user` msg slice 120.
- `deleteProject(id)` — `deleteMany({id,userId})` + revalidate.
- `checkUser()` — `currentUser()` null->null; `getCurrentPlan()` via `has({plan:pro|starter})`; existing + plan change -> upgrade-only delta (`newCredits-oldCredits` if >0) via `updateMany({clerkId,plan:old})`; else return existing; new -> `create({credits: PLANS.free.credits, plan: free})`.

## WorkspaceClient — `components/WorkspaceClient.tsx`

- `parseMessages(raw)`, `parseFileData(raw)` — runtime guards for DB Json.
- `pushStep(label)` — marks prev done, appends running. `completeSteps()` — marks last done.
- `handleGenerate(prompt, imageUrl?)` — guards `isGenerating/credits`; pushes user msg; `fetch POST /api/gen-ai-code {workspaceId,userId,messages,fileData:ref}` with AbortController; SSE loop parses `status/done/error{code,retryAfter}`; `done` sets workspace/file/credits + assistant msg + `replaceState ?id=`; `error` throws with code; `AbortError` silent rollback 1 msg; else `toast.error(duration 5s or 8–15s quota)` + rollback.
- `handleImprove(userRequest, imageUrl?)` — guards generating/improving/credits/workspaceId/fileData; pushes user (with imageUrl) + empty assistant placeholder; POST `/api/improve {userId,workspaceId,userRequest,imageUrl?,messages,fileData}`; streams `thinking` into placeholder, applies `fileData` on `done` (sets file/credits, replaces thinking with summary); 402 toast; Abort rollback 2 msgs.
- `onGenerate = workspaceId && fileData ? handleImprove : handleGenerate` — hybrid routing passed to ChatPanel. `handleFixError(error)` — agent path when files exist, else generation.
- `handleStop()` — aborts both controllers.

## ChatPanel / CodePanel

- `ChatPanel handleSubmit/handleKeyDown(Enter)` — sends trimmed input + pending image. `handleFileChange` — validates `image/*`, uploads `userId/workspaceId|new/timestamp.ext` to `workspace-images`, stores public URL.
- `CodePanel SandpackInner useEffect[fileData]` — diffs `prevFilesRef` vs new, `sandpack.updateFile` per changed path. `listen` effect maps `show-error/compile->previewError`, `success->null`. Agent-edits pill + overlay while `isImproving`. `handleExportZip` (JSZip: package.json react 18 + deps, public/index.html + tailwind CDN, `src/<path>` files, `src/index.js` StrictMode render, README, slugified `appTitle.zip`).
