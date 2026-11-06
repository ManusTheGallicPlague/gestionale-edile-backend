/**
 * Checks responses against contract/openapi.yaml: the status must be declared for the
 * operation, the JSON body must match its schema, declared headers must be there.
 */
import { readFileSync } from 'node:fs'
import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormatsModule from 'ajv-formats'
import type { Response as InjectResponse } from 'light-my-request'
import { parse } from 'yaml'
import { expect } from 'vitest'

type Json = Record<string, unknown>

const doc = parse(
  readFileSync(new URL('../contract/openapi.yaml', import.meta.url), 'utf8'),
) as Json
const ajv = new Ajv2020({ strict: false, allErrors: true })
const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => void
addFormats(ajv)
ajv.addFormat('password', true)
ajv.addSchema(doc, 'openapi')

const paths = doc.paths as Record<string, Json>
const pointer = (...parts: string[]) =>
  parts.map((p) => encodeURIComponent(p.replace(/~/g, '~0').replace(/\//g, '~1'))).join('/')

function findTemplate(path: string): string {
  const clean = path.split('?')[0] ?? path
  const template = Object.keys(paths).find((t) =>
    new RegExp(`^${t.replace(/\{[^}]+\}/g, '[^/]+')}$`).test(clean),
  )
  if (!template) throw new Error(`No contract path for ${clean}`)
  return template
}

/** Asserts that the response is one the contract allows for this request. */
export function expectContract(res: InjectResponse, method: string, path: string) {
  const template = findTemplate(path)
  const operation = paths[template]?.[method.toLowerCase()] as Json | undefined
  if (!operation) throw new Error(`No contract operation ${method} ${template}`)
  const responses = operation.responses as Record<string, Json>
  const status = String(res.statusCode)
  expect(Object.keys(responses), `${method} ${template} does not declare ${status}`).toContain(
    status,
  )

  let base = ['paths', template, method.toLowerCase(), 'responses', status]
  let response = responses[status] as Json
  const ref = response.$ref as string | undefined
  if (ref) {
    base = ref.replace(/^#\//, '').split('/')
    response = base.reduce<Json>((node, key) => node[key] as Json, doc)
  }

  const headers = (response.headers ?? {}) as Record<string, unknown>
  for (const name of Object.keys(headers)) {
    expect(res.headers[name.toLowerCase()], `missing header ${name}`).toBeDefined()
  }

  const content = response.content as Json | undefined
  if (!content) {
    expect(res.body, `${status} should have no body`).toBe('')
    return
  }
  if (!('application/json' in content)) {
    // Files: the content type must be one the contract declares.
    const type = String(res.headers['content-type'] ?? '').split(';')[0]
    expect(Object.keys(content), `${method} ${path} ${status}: content type`).toContain(type)
    return
  }
  const validate = ajv.compile({
    $ref: `openapi#/${pointer(...base, 'content', 'application/json', 'schema')}`,
  })
  const body: unknown = res.json()
  const valid = validate(body)
  expect(valid, `${method} ${path} ${status}: ${ajv.errorsText(validate.errors)}`).toBe(true)
}
