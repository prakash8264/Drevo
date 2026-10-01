import Link from "next/link";
import { UserButton, SignInButton, Show } from "@clerk/nextjs";
import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LogoMark } from "@/components/LogoMark";
import { HeaderCredits } from "@/components/HeaderCredits";
import { OrgSwitcher } from "@/components/OrgSwitcher";
import { MembersDialog } from "@/components/MembersDialog";
import { checkUser } from "@/lib/checkUser";
import { ThemeToggle } from "@/components/ThemeToggle";

export default async function Header() {
  const user = await checkUser();

  const pick = user?.memberships.find((member) => member.organization.id === user.activeOrganizationId)
    ?? user?.memberships[0];
  const orgCredits = pick?.organization.credits ?? null;
  const orgPlan = pick?.organization.plan ?? null;
  const orgRole = pick?.role ?? null;
  const orgs = user?.memberships.map(({ organization, role }) => ({ ...organization, role })) ?? [];

  return (
    <header className="fixed top-0 left-0 right-0 z-50 h-16 border-b border-white/6 bg-white/7 backdrop-blur-md">
      <nav className="mx-auto flex h-full max-w-7xl items-center justify-between px-4 sm:px-6">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-2 select-none" aria-label="Drevo home">
          <LogoMark size="md" />
        </Link>

        {/* Right side */}
        <div className="flex items-center gap-2 sm:gap-4">
          <ThemeToggle />
          <Show when="signed-in">
            <Link
              href="/projects"
              className="hidden text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground sm:block"
            >
              Projects
            </Link>

            <OrgSwitcher orgs={orgs} activeOrganizationId={pick?.organization.id ?? null} />
            <MembersDialog key={`members-${pick?.organization.id}`} />
            {orgCredits !== null && pick && <HeaderCredits key={`credits-${pick.organization.id}`} orgId={pick.organization.id} initial={orgCredits} orgPlan={orgPlan} orgRole={orgRole} />}

            <UserButton />
          </Show>

          <Show when="signed-out">
            <SignInButton mode="modal">
              <Button
                variant="ghost"
                size="sm"
                className="text-[13px] font-medium text-muted-foreground hover:text-foreground hover:bg-transparent"
              >
                Sign in
              </Button>
            </SignInButton>

            <SignInButton mode="modal">
              <Button
                size="sm"
                className="inline-flex h-8 items-center gap-1.5 rounded-full bg-primary px-4 text-[13px] font-semibold text-primary-foreground hover:bg-primary/90 active:scale-95"
              >
                Get Started
                <ArrowRight className="h-3 w-3 opacity-60" />
              </Button>
            </SignInButton>
          </Show>
        </div>
      </nav>
    </header>
  );
}
