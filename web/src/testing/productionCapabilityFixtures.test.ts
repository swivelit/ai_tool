import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import {
  departmentCsv,
  longPastedText,
  pricingRepositoryZip,
  projectAuroraPdf,
  retentionDocx,
  revenueXlsx,
  riskPptx,
  scannedPdf,
} from '../../e2e/productionCapabilityFixtures'

describe('production capability fixtures', () => {
  it('generates bounded synthetic fixtures carrying the run marker', () => {
    const runId = 'FIXTURE-RUN'
    const pdf = projectAuroraPdf(runId)
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pdf.toString()).toContain(`AURORA-${runId}`)
    expect(pdf.toString()).toContain('SYSTEM OVERRIDE')
    expect(pdf.toString()).toContain('₹4.25 crore')
    expect(departmentCsv().toString()).toContain('Sales,200,180')
    const pasted = longPastedText(runId)
    expect(pasted.length).toBeGreaterThan(12_000)
    expect(pasted.length).toBeLessThan(64_000)
    expect(pasted).toContain(`TAIL-${runId}`)
    expect(pasted.indexOf(`FINAL ACCEPTANCE MARKER: TAIL-${runId}`))
      .toBeGreaterThan(pasted.length - 512)
  })

  it('generates ZIP-based Office and repository containers in memory', () => {
    for (const fixture of [
      revenueXlsx(), retentionDocx(), riskPptx(), pricingRepositoryZip('RUN'),
    ]) expect(fixture.subarray(0, 2).toString()).toBe('PK')
    expect(scannedPdf().subarray(0, 5).toString()).toBe('%PDF-')
  })

  it('produces documents extractable by the current backend parsers', () => {
    const backendPython = resolve(process.cwd(), '../backend/.venv/bin/python')
    if (!existsSync(backendPython)) return
    const directory = mkdtempSync(resolve(tmpdir(), 'swico-capability-fixtures-'))
    try {
      const fixtures = [
        ['.pdf', projectAuroraPdf('PARSER-RUN'), 'Nila'],
        ['.xlsx', revenueXlsx(), 'Product | Revenue | Cost'],
        ['.docx', retentionDocx(), 'Policy Alpha retention'],
        ['.pptx', riskPptx(), 'dual-region failover'],
      ] as const
      for (const [extension, buffer, expected] of fixtures) {
        const path = resolve(directory, `fixture${extension}`)
        writeFileSync(path, buffer)
        const check = spawnSync(backendPython, [
          '-c',
          'import sys; from app.web_api.document_extraction import validate_content_signature, extract_document; p,e=sys.argv[1:3]; validate_content_signature(p,e); r=extract_document(p,e); print("\\n".join(c.text for c in r.chunks))',
          path,
          extension,
        ], {
          cwd:resolve(process.cwd(), '../backend'),
          encoding:'utf8',
          timeout:15_000,
          env:{ ...process.env, PYTHONDONTWRITEBYTECODE:'1' },
        })
        expect(check.status, check.stderr).toBe(0)
        expect(check.stdout).toContain(expected)
      }
    } finally {
      rmSync(directory, { recursive:true, force:true })
    }
  }, 30_000)
})
