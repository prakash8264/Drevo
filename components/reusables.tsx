export const GrayTitle = ({ children }: { children: React.ReactNode }) => (
  <span className="text-white/90">{children}</span>
);

export const BrandTitle = ({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) => (
  <span
    className={`bg-linear-to-br font-serif from-violet-300 via-violet-400 to-indigo-600 bg-clip-text text-transparent ${className}`}
  >
    {children}
  </span>
);

export const SectionLabel = ({ children }: { children: React.ReactNode }) => (
  <p className="inline-flex items-center gap-2 text-xs font-semibold text-violet-400 tracking-[0.14em] uppercase mb-4">
    <span className="w-4 h-px bg-violet-400" />
    {children}
    <span className="w-4 h-px bg-violet-400" />
  </p>
);

export const SectionHeading = ({
  gray,
  brand,
}: {
  gray: string;
  brand: string;
}) => (
  <h2 className="font-serif text-[clamp(2rem,4vw,3rem)] leading-[1.1] tracking-tight">
    <GrayTitle>{gray}</GrayTitle>
    <br />
    <BrandTitle>{brand}</BrandTitle>
  </h2>
);