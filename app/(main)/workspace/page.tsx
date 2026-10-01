import { WorkspaceClient } from "@/components/WorkspaceClient";
import { getWorkspaceUser, getWorkspaceById } from "@/actions/workspace";

interface WorkspacePageProps {
  searchParams: Promise<{ prompt?: string; id?: string }>;
}

export default async function WorkspacePage({
  searchParams,
}: WorkspacePageProps) {
  const { prompt, id } = await searchParams;

  const user = await getWorkspaceUser(id);

  let workspace = null;
  if (id) {
    workspace = await getWorkspaceById(id);
  }

  return (
    <WorkspaceClient
      key={`${user.orgId}:${workspace?.id ?? "new"}:${workspace?.revision ?? 0}`}
      initialPrompt={prompt ?? null}
      workspace={workspace}
      userCredits={user.credits}
      userId={user.id}
      orgId={user.orgId}
      userRole={user.role}
      githubConnected={user.githubConnected}
      githubUsername={user.githubUsername}
    />
  );
}
