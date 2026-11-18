/** `npm run mock`: runs the simulated Simpro so you can try the MCP without a real account. */
import { startMockSimpro } from "./simpro.js";

const port = Number(process.env.MOCK_PORT ?? 4010);
startMockSimpro({}, port).then((m) => {
  console.log(`Simulated Simpro running at ${m.url}

Point the MCP server at it with:
  SIMPRO_BASE_URL=${m.url}
  SIMPRO_API_KEY=mock-key

(OAuth test app: client id "mock-client", secret "mock-secret".)
Press Ctrl+C to stop.`);
});
