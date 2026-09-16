"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, ExternalLink, Check } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";

export interface LastPush {
  repoUrl: string;
  fullName: string;
  branch: string;
  pushedAt: string;
}

interface GithubPushDialogProps {
  workspaceId: string | null;
  appTitle: string | null;
  fileDataPresent: boolean;
  disabled?: boolean;
  githubConnected: boolean;
  githubUsername: string | null;
  lastPush: LastPush | null;
  onPushed: (push: LastPush) => void;
  onConnectionChange: (connected: boolean, username: string | null) => void;
}

function GithubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function slugify(title: string | null): string {  if (!title) return "";
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

export function GithubPushDialog({
  workspaceId,
  appTitle,
  fileDataPresent,
  disabled,
  githubConnected,
  githubUsername,
  lastPush,
  onPushed,
  onConnectionChange,
}: GithubPushDialogProps) {
  // Open immediately after returning from GitHub OAuth (?github=connected).
  const [open, setOpen] = useState(
    () =>
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("github") === "connected"
  );
  const [repoName, setRepoName] = useState(() => slugify(appTitle));
  const [isPrivate, setIsPrivate] = useState(true);
  const [commitMessage, setCommitMessage] = useState("Initial commit from Drevo");
  const [isPushing, setIsPushing] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [justPushed, setJustPushed] = useState<LastPush | null>(null);
  const [failedRepo, setFailedRepo] = useState<{ repoUrl: string; fullName: string } | null>(null);

  const handleOpenChange = (next: boolean) => {
    // Prefill repo name from the app title the first time the dialog opens.
    if (next && !repoName) setRepoName(slugify(appTitle) || "drevo-app");
    setOpen(next);
  };

  // Surface the OAuth callback result (?github=connected / error).
  // State updates happen in async callbacks, never synchronously in the body.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get("github");
    if (!status) return;
    params.delete("github");
    const clean = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}`;
    window.history.replaceState(null, "", clean);
    if (status === "connected") {
      toast.success("GitHub connected. You can push now.");
      // Re-read connection state from the server.
      fetch("/api/github/status")
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          if (j && typeof j.connected === "boolean")
            onConnectionChange(j.connected, j.username ?? null);
        })
        .catch(() => {});
    } else if (status === "error") {
      toast.error("GitHub connection failed. Please try again.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const repoNameError = useMemo(() => {
    const t = repoName.trim();
    if (!t) return "Repository name is required.";
    if (t.length > 100) return "Keep it under 100 characters.";
    if (!/^[a-zA-Z0-9._-]+$/.test(t)) return "Letters, numbers, dots, hyphens, underscores only.";
    if (t.startsWith(".") || t.endsWith(".")) return "Cannot start or end with a dot.";
    if (t.includes("..")) return "Cannot contain consecutive dots.";
    return null;
  }, [repoName]);

  const canPush =
    fileDataPresent && workspaceId && !isPushing && !repoNameError && commitMessage.trim().length > 0;

  const handlePush = async () => {
    if (!canPush) return;
    setIsPushing(true);
    setJustPushed(null);
    setFailedRepo(null);
    try {
      const res = await fetch("/api/github/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          repoName: repoName.trim(),
          isPrivate,
          commitMessage: commitMessage.trim(),
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        repoUrl?: string;
        fullName?: string;
        branch?: string;
        message?: string;
        code?: string;
      } | null;
      if (res.status === 401 && data?.code === "GITHUB_NOT_CONNECTED") {
        onConnectionChange(false, null);
        toast.error("GitHub is not connected. Connect first, then push.");
        return;
      }
      if (res.status === 401 && data?.code === "GITHUB_TOKEN_INVALID") {
        onConnectionChange(false, null);
        toast.error("GitHub session expired. Reconnect and try again.");
        return;
      }
      if (!res.ok || !data?.repoUrl) {
        // The repo may have been created before the upload failed.
        // Surface its link so the user can inspect or delete it.
        if (data?.code === "REPO_CREATED_PUSH_FAILED" && data.repoUrl) {
          setFailedRepo({ repoUrl: data.repoUrl, fullName: data.fullName ?? repoName.trim() });
        }
        toast.error(data?.message ?? "Push to GitHub failed. Please try again.");
        return;
      }
      const push: LastPush = {
        repoUrl: data.repoUrl,
        fullName: data.fullName ?? repoName.trim(),
        branch: data.branch ?? "main",
        pushedAt: new Date().toISOString(),
      };
      setJustPushed(push);
      onPushed(push);
      toast.success("Pushed to GitHub.");
    } catch {
      toast.error("Push to GitHub failed. Check your connection and try again.");
    } finally {
      setIsPushing(false);
    }
  };

  const handleDisconnect = async () => {
    setIsDisconnecting(true);
    try {
      const res = await fetch("/api/github/disconnect", { method: "DELETE" });
      if (!res.ok) throw new Error();
      onConnectionChange(false, null);
      toast.success("GitHub disconnected.");
    } catch {
      toast.error("Could not disconnect GitHub.");
    } finally {
      setIsDisconnecting(false);
    }
  };

  const shown = justPushed ?? lastPush;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            disabled={disabled || !fileDataPresent}
            title={fileDataPresent ? "Push to GitHub" : "Generate an app first"}
          />
        }
      >
        <GithubMark className="h-3.5 w-3.5" />
        GitHub
      </DialogTrigger>
      <DialogContent className="border-white/8 bg-[#0f0f0f] text-white sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-white/90">Push to GitHub</DialogTitle>
          <DialogDescription className="text-sm text-white/35">
            {githubConnected
              ? `Connected as ${githubUsername ?? "your account"}. Creates a new repository on the main branch.`
              : "Connect your GitHub account, then create a repository for this project."}
          </DialogDescription>
        </DialogHeader>

        {!githubConnected ? (
          <div className="flex flex-col gap-3">
            <Button
              onClick={() => {
                // Full navigation is required: the endpoint 302-redirects to github.com.
                // eslint-disable-next-line @next/next/no-location-assign-relative-destination
                window.location.href = `/api/github/connect${workspaceId ? `?workspaceId=${workspaceId}` : ""}`;
              }}
            >
              <GithubMark className="h-4 w-4" />
              Connect with GitHub
            </Button>
            <p className="text-[11px] leading-relaxed text-white/25">
              Drevo requests the minimum scope needed to create repositories and push code. The
              token is stored encrypted and never shown in the browser.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-white/60">Repository name</span>
              <input
                value={repoName}
                onChange={(e) => setRepoName(e.target.value)}
                placeholder="my-awesome-app"
                maxLength={100}
                className="h-9 rounded-md border border-white/10 bg-white/5 px-3 text-sm text-white placeholder:text-white/25 focus:border-violet-500/60 focus:outline-none"
              />
              {repoNameError && <span className="text-[11px] text-red-400/80">{repoNameError}</span>}
            </label>

            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-white/60">Visibility</span>
              <div className="grid grid-cols-2 gap-2">
                {(["private", "public"] as const).map((v) => {
                  const active = (v === "private") === isPrivate;
                  return (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setIsPrivate(v === "private")}
                      className={`rounded-md border px-3 py-2 text-left text-sm capitalize transition-colors ${
                        active
                          ? "border-violet-500/60 bg-violet-500/15 text-white"
                          : "border-white/10 bg-white/5 text-white/50 hover:text-white/80"
                      }`}
                    >
                      {v}
                      <span className="block text-[11px] font-normal opacity-60">
                        {v === "private" ? "Only you can see it" : "Anyone can see it"}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-white/60">Commit message</span>
              <input
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
                maxLength={500}
                className="h-9 rounded-md border border-white/10 bg-white/5 px-3 text-sm text-white placeholder:text-white/25 focus:border-violet-500/60 focus:outline-none"
              />
            </label>

            <Button onClick={handlePush} disabled={!canPush}>
              {isPushing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <GithubMark className="h-4 w-4" />
              )}
              {isPushing ? "Pushing…" : "Create repo and push"}
            </Button>

            {failedRepo && !justPushed && (
              <div className="flex flex-col gap-1.5 rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-sm">
                <p className="text-[12px] leading-relaxed text-amber-200/80">
                  The repository was created, but the file upload did not finish. You can delete
                  the empty repo and try again.
                </p>
                <a
                  href={failedRepo.repoUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex min-w-0 items-center gap-1 truncate text-amber-300 hover:underline"
                >
                  <span className="truncate">{failedRepo.fullName}</span>
                  <ExternalLink className="h-3 w-3 shrink-0" />
                </a>
              </div>
            )}

            {shown && (
              <div className="flex items-center gap-2 rounded-md border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-sm">
                <Check className="h-4 w-4 shrink-0 text-emerald-400" />
                <a
                  href={shown.repoUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex min-w-0 flex-1 items-center gap-1 truncate text-emerald-300 hover:underline"
                >
                  <span className="truncate">{shown.fullName}</span>
                  <ExternalLink className="h-3 w-3 shrink-0" />
                </a>
                <span className="shrink-0 text-[11px] text-emerald-400/60">{shown.branch}</span>
              </div>
            )}

            <button
              onClick={handleDisconnect}
              disabled={isDisconnecting}
              className="self-start text-[11px] text-white/25 hover:text-white/60 disabled:opacity-40"
            >
              {isDisconnecting ? "Disconnecting…" : "Disconnect GitHub"}
            </button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
