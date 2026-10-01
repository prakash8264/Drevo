export const PLANS = {
  free: {
    label: "Free",
    credits: 10,
    price: 0,
  },
  starter: {
    label: "Starter",
    credits: 50,
    price: 20,
  },
  pro: {
    label: "Pro",
    credits: 150,
    price: 29,
  },
} as const;

export const CREDIT_COST_PER_GENERATION = 1;

export const MIN_CREDITS_TO_GENERATE = 1;

export const PRICING_PLANS = [
  {
    key: "free",
    label: "Free",
    description: "Start building. No credit card required.",
    price: 0,
    featured: false,
    planId: null,
    active: true,
    features: [
      "10 trial credits (once per user)",
      "Agent-powered edits",
      "Image uploads",
      "Live preview",
      "Export to zip",
    ],
  },
  {
    key: "starter",
    label: "Starter",
    description: "For developers who build regularly.",
    price: 20,
    featured: true,
    planId: "cplan_3K2DXlsyW4SPI7QFY7WGnwgTvxe",
    active: true,
    features: [
      "50 generations / month",
      "Unused credits roll over",
      "Agent-powered edits",
      "Image uploads",
      "Live preview",
      "Export to zip",
    ],
  },
  {
    key: "pro",
    label: "Pro",
    description: "For power users who ship fast.",
    price: 29,
    featured: false,
    planId: "cplan_3K2J6Vgaiww60XSxqKHGcSwGvGa",
    active: true,
    features: [
      "150 generations / month",
      "Unused credits roll over",
      "Priority AI (faster response)",
      "Agent-powered edits",
      "Live preview",
      "Export to zip",
      "Image uploads",
    ],
  },
] as const;
