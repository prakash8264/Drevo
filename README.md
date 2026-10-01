This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Security/billing release (October 2026)

Before deploying the updated application, back up the database and apply the
additive `20261001090000_security_billing_persistence` migration with
`npx prisma migrate deploy` against the intended `DIRECT_URL`. Do not use
`prisma db push`, reset the database, or replay real billing events to test it.
The migration preserves all balances/history and marks existing users as
already trial-allocated. It records the existing paid plan as a baseline so
its pre-release billing period is not credited a second time.

- New users receive one 10-credit allocation in their initial personal
  organization. Extra organizations start with zero credits; deleting an
  organization does not reset the user's trial eligibility.
- Active non-trial monthly paid periods and verified `paymentAttempt.paid`
  periods receive a deduplicated additive allowance. Existing credits roll
  over; cancellation/downgrade never subtracts them. Annual allowances are
  intentionally not enabled for the monthly-only plans.
- Configure the Clerk webhook for subscription, subscription-item,
  `paymentAttempt.paid`, membership created/updated/deleted, and organization
  created/deleted events. Failures return 5xx for provider retries.
- Paid/unresolved subscriptions block organization deletion; cancel billing
  and wait for the subscription to end first.
- Legacy GitHub metadata remains untouched, but deletion history is not
  imported into a guessed member/repository/branch. Exact-target tracking
  starts with the next successful push.

Run `npm test`, `npx prisma validate`, the TypeScript check and `npm run build`.
The regression suite uses mocks plus Prisma's installed in-memory PostgreSQL
dependency, never production credentials. Dependency overrides patch Prisma's
transitive packages without changing the Prisma major version.

### Provider configuration still needs verification

Clerk's default `org:admin` role represents both local OWNER and ADMIN. The app
guards its checkout and subscription controls as OWNER-only, but this alone
does not restrict Clerk's own billing interfaces/APIs. Verify provider billing
permissions (or configure a distinct owner role) before claiming provider-level
OWNER-only billing. Verify real webhook delivery/renewal behavior and Supabase
Storage authorization policies in a test organization before production rollout.
