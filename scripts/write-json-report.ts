import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function emitJsonReport(
  report: unknown,
  destinationEnvironmentKey: string,
): Promise<void> {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (process.env.MAESTRO_REPORT_STDOUT !== '0') process.stdout.write(serialized);
  const destination = process.env[destinationEnvironmentKey];
  if (!destination) return;
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, serialized, 'utf8');
}
