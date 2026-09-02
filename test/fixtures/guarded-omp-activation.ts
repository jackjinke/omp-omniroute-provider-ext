export {};

const guardedEvents = [
  "uncaughtException",
  "unhandledRejection",
  "exit",
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
  "SIGUSR1",
] as const;

const listenerCounts = () => Object.fromEntries(
  guardedEvents.map(event => [event, process.listenerCount(event)]),
);
const before = listenerCounts();
let providerRegistrations = 0;
const originalExit = process.exit;
const originalReallyExit = process.reallyExit;
const guardedExit = () => {
  throw new Error("host process exit attempted during guarded extension activation");
};

process.exit = guardedExit as typeof process.exit;
process.reallyExit = guardedExit as typeof process.reallyExit;
try {
  // Runtime import intentionally reproduces OMP loading extension source under its host guard.
  const { activateOmp } = await import("../../src/omp.ts");
  await activateOmp(
    {
      registerProvider() {
        providerRegistrations++;
      },
      getThinkingLevel: () => "high",
      async setModel() {
        return true;
      },
      on() {},
    },
    {
      OMNIROUTE_API_KEY: "secret",
      PI_CODING_AGENT_DIR: "/tmp/omniroute-guarded-activation-fixture",
    },
    async () => Response.json({ data: [{ id: "combo/coding", owned_by: "combo" }] }),
  );
} finally {
  process.exit = originalExit;
  process.reallyExit = originalReallyExit;
}

const after = listenerCounts();
console.log(JSON.stringify({
  providerRegistrations,
  ...Object.fromEntries(guardedEvents.map(event => [event, after[event] - before[event]])),
}));
