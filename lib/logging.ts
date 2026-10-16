// On Cloud Run, console output becomes one JSON line per call so Cloud Logging knows its severity
// (console.error → ERROR, console.warn → WARNING). The admin page's log view filters on it.
import { format } from "node:util";

export function installStructuredLogging(): void {
  const write = (severity: string) =>
    (...args: unknown[]) => {
      process.stdout.write(`${JSON.stringify({ severity, message: format(...args) })}\n`);
    };
  console.log = write("INFO");
  console.info = write("INFO");
  console.warn = write("WARNING");
  console.error = write("ERROR");
  console.debug = write("DEBUG");
}
