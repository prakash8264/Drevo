// Concurrency test for atomic org-credit guard (Decision 14).
// Creates a temp org with 1 credit, fires two parallel guarded decrements
// mimicking the AI success transactions, asserts exactly one wins and the
// final balance is 0. Run with: npx tsx scripts/test-credit-concurrency.ts
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../lib/generated/prisma/client.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const db = new PrismaClient({ adapter });

async function main() {
  const org = await db.organization.create({
    data: { name: `__credit_test_${Date.now()}`, plan: "free", credits: 1 },
  });
  try {
    const spend = () =>
      db.organization.updateMany({
        where: { id: org.id, credits: { gte: 1 } },
        data: { credits: { decrement: 1 } },
      });
    const [a, b] = await Promise.all([spend(), spend()]);
    const total = a.count + b.count;
    const final = await db.organization.findUnique({
      where: { id: org.id },
      select: { credits: true },
    });
    console.log(`attempts won: ${total} (a=${a.count}, b=${b.count}), final=${final?.credits}`);
    if (total !== 1 || final?.credits !== 0) {
      console.error("FAIL: expected exactly one winner and final balance 0");
      process.exitCode = 1;
    } else {
      console.log("PASS: atomic guard holds under concurrency");
    }
  } finally {
    await db.organization.delete({ where: { id: org.id } }).catch(() => {});
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
