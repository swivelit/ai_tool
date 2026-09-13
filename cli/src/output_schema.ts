import { Ajv, type ValidateFunction } from 'ajv'
import { access, link, readFile, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const MAX_SCHEMA_BYTES = 64 * 1024
const MAX_OUTPUT_BYTES = 256 * 1024

export type OutputValidator = { schema: Record<string, unknown>; validate(value: unknown): void }

export async function loadOutputValidator(path: string): Promise<OutputValidator> {
  const bytes = await readFile(path)
  if (bytes.byteLength > MAX_SCHEMA_BYTES) throw new Error('--output-schema is larger than the 64 KiB limit.')
  let schema: unknown
  try { schema = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('--output-schema must contain valid JSON.') }
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('--output-schema must be a JSON Schema object.')
  let compiled: ValidateFunction
  try { compiled = new Ajv({ allErrors: false, strict: true }).compile(schema) }
  catch (error) { throw new Error(`--output-schema is not a supported JSON Schema: ${error instanceof Error ? error.message : 'schema compilation failed'}`) }
  return {
    schema: schema as Record<string, unknown>,
    validate(value: unknown) {
      if (!compiled(value)) throw new Error(`The response did not match --output-schema${compiled.errors?.[0]?.instancePath ? ` at ${compiled.errors[0].instancePath}` : ''}.`)
    },
  }
}

export function parseStructuredOutput(text: string, validator: OutputValidator): string {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > MAX_OUTPUT_BYTES) throw new Error('The structured response exceeded the 256 KiB limit.')
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new Error('The response was not valid JSON for --output-schema.') }
  validator.validate(value)
  return `${JSON.stringify(value)}\n`
}

/** Publish only after validation, without clobbering an existing path. */
export async function publishOutputAtomically(path: string, content: string): Promise<void> {
  try { await access(path); throw new Error(`Output file already exists: ${path}`) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const temporary = join(dirname(path), `.${randomUUID()}.swico-output.tmp`)
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 })
    // link() is an atomic no-clobber publication on the same filesystem.
    await link(temporary, path)
  } finally { await unlink(temporary).catch(() => undefined) }
}
