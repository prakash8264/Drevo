import { Zap } from "lucide-react";
import { cn } from "@/lib/utils";

interface LogoMarkProps {
  size?: "sm" | "md";
  className?: string;
}

export function LogoMark({ size = "md", className }: LogoMarkProps) {
  const box = size === "sm" ? "h-6 w-6 rounded-md" : "h-8 w-8 rounded-lg";
  const icon = size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4";

  return (
    <div
      role="img"
      aria-label="Drevo"
      className={cn(
        "flex shrink-0 items-center justify-center border border-white/10 bg-white/10",
        box,
        className
      )}
    >
      <Zap className={cn("text-white", icon)} fill="currentColor" />
    </div>
  );
}
