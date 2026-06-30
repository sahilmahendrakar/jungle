// Stop and remove the local Postgres container (data volume is kept).
// Run: npm run db:down
import { execSync } from "node:child_process";

const CONTAINER = "jungle-postgres";

try {
  execSync(`docker rm -f ${CONTAINER}`, { stdio: "inherit" });
  console.log(`${CONTAINER} removed (volume jungle-postgres-data kept)`);
} catch {
  console.log(`${CONTAINER} was not running`);
}
