import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

export interface PostgresConnectionOptions {
  database: string;
  host: string;
  password?: string;
  port?: string;
  sslMode?: string;
  username: string;
}

export function parseConnectionString(connectionString: string): PostgresConnectionOptions {
  const url = new URL(connectionString);
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  if (!database) throw new Error('database_name_required');

  const options: PostgresConnectionOptions = {
    database,
    host: url.hostname || 'localhost',
    username: decodeURIComponent(url.username || 'postgres'),
  };

  if (url.password) options.password = decodeURIComponent(url.password);
  if (url.port) options.port = url.port;

  const sslMode = url.searchParams.get('sslmode');
  if (sslMode) options.sslMode = sslMode;

  return options;
}

export function connectionStringForDatabase(connectionString: string, database: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(database)) throw new Error('database_name_invalid');
  const url = new URL(connectionString);
  url.pathname = '/' + database;
  url.searchParams.delete('schema');
  return url.toString();
}

export function normalizeConnectionString(connectionString: string): string {
  const url = new URL(connectionString);
  url.searchParams.delete('schema');
  return url.toString();
}

function connectionArguments(connectionString: string): {
  args: string[];
  env: NodeJS.ProcessEnv;
} {
  const options = parseConnectionString(connectionString);
  const args = [
    '--host',
    options.host,
    '--username',
    options.username,
    '--dbname',
    options.database,
  ];
  if (options.port) args.push('--port', options.port);

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (options.password) env.PGPASSWORD = options.password;
  if (options.sslMode) env.PGSSLMODE = options.sslMode;

  return { args, env };
}

export async function runPostgresTool(
  tool: 'pg_dump' | 'pg_restore',
  toolEnvironmentVariable: 'PG_DUMP_BIN' | 'PG_RESTORE_BIN',
  connectionString: string,
  argumentsToAppend: string[],
): Promise<void> {
  const connection = connectionArguments(connectionString);
  const container = process.env.PG_TOOL_CONTAINER;
  const toolArguments = [...argumentsToAppend];
  let inputPath: string | undefined;
  let outputPath: string | undefined;

  if (container && tool === 'pg_dump') {
    const fileIndex = toolArguments.indexOf('--file');
    const file = fileIndex >= 0 ? toolArguments[fileIndex + 1] : undefined;
    if (!file) throw new Error('pg_dump_output_required_for_container');
    outputPath = file;
    toolArguments.splice(fileIndex, 2);
  }
  if (container && tool === 'pg_restore') {
    const archive = toolArguments.at(-1);
    if (!archive || archive.startsWith('-'))
      throw new Error('pg_restore_archive_required_for_container');
    inputPath = archive;
    toolArguments.pop();
  }

  const executable = container ? 'docker' : (process.env[toolEnvironmentVariable] ?? tool);
  const containerConnectionArgs = connection.args.filter(
    (argument, index, all) =>
      argument !== '--host' &&
      argument !== '--port' &&
      all[index - 1] !== '--host' &&
      all[index - 1] !== '--port',
  );
  const args = container
    ? ['exec', '-i', container, tool, ...containerConnectionArgs, ...toolArguments]
    : [...connection.args, ...toolArguments];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {
      env: connection.env,
      stdio: [inputPath ? 'pipe' : 'ignore', outputPath ? 'pipe' : 'ignore', 'pipe'],
    });
    let stderr = '';
    let streamError: unknown;
    const outputPromise = outputPath
      ? pipeline(child.stdout!, createWriteStream(outputPath)).catch((error: unknown) => {
          streamError = error;
        })
      : Promise.resolve();
    const inputPromise = inputPath
      ? pipeline(createReadStream(inputPath), child.stdin!).catch((error: unknown) => {
          streamError = error;
        })
      : Promise.resolve();

    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => {
      reject(new Error(tool + '_unavailable: ' + error.message, { cause: error }));
    });
    child.once('close', async (code, signal) => {
      await Promise.all([outputPromise, inputPromise]);
      if (streamError) {
        reject(
          new Error(
            tool +
              '_stream_failed: ' +
              (streamError instanceof Error ? streamError.message : String(streamError)),
          ),
        );
        return;
      }
      if (code === 0) {
        resolve();
        return;
      }

      const detail =
        stderr.trim() || 'process exited with ' + (signal ?? 'code ' + (code ?? 'unknown'));
      reject(new Error(tool + '_failed: ' + detail));
    });
  });
}
