import { describe, expect, it } from 'vitest'
import {
  assertPythonTestRuntimeAvailable,
  extractPythonBlocks,
  extractUnifiedDiff,
  normalizeGeneratedUnifiedDiff,
  testGeneratedDiscountPython,
  testRepositoryPatch,
  validateRepositoryDiff,
} from '../../e2e/productionCapabilityCodeRunner'

const pythonAnswer = `\`\`\`python
# pricing.py
from decimal import Decimal, ROUND_HALF_UP

def apply_discount(total: Decimal, percent: Decimal) -> Decimal:
    if total < Decimal("0"):
        raise ValueError("total")
    if not Decimal("0") <= percent <= Decimal("100"):
        raise ValueError("percent")
    return (total * (Decimal("1") - percent / Decimal("100"))).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
\`\`\`
\`\`\`python
# test_pricing.py
from decimal import Decimal
import pytest
from pricing import apply_discount

def test_one(): assert apply_discount(Decimal("100"), Decimal("15")) == Decimal("85.00")
def test_two(): assert apply_discount(Decimal("1"), Decimal("0")) == Decimal("1.00")
def test_three(): assert apply_discount(Decimal("1"), Decimal("100")) == Decimal("0.00")
def test_four():
    with pytest.raises(ValueError): apply_discount(Decimal("-1"), Decimal("2"))
def test_five():
    with pytest.raises(ValueError): apply_discount(Decimal("1"), Decimal("101"))
\`\`\``

const patchAnswer = `\`\`\`diff
diff --git a/src/pricing.js b/src/pricing.js
--- a/src/pricing.js
+++ b/src/pricing.js
@@ -5,5 +5,8 @@ export function finalPrice(subtotalCents, discountPercent) {
   if (!Number.isInteger(discountPercent)) {
     throw new TypeError('discountPercent must be an integer')
   }
-  return subtotalCents - discountPercent
+  if (discountPercent < 0 || discountPercent > 100) {
+    throw new RangeError('discountPercent must be between 0 and 100')
+  }
+  return subtotalCents - Math.round(subtotalCents * discountPercent / 100)
 }
diff --git a/src/orderService.js b/src/orderService.js
--- a/src/orderService.js
+++ b/src/orderService.js
@@ -1,9 +1,9 @@
 import { finalPrice } from './pricing.js'
 
 export function createOrder(order) {
   return {
     id: order.id,
-    totalCents: finalPrice(order.subtotalCents, order.discountRate),
+    totalCents: finalPrice(order.subtotalCents, order.discountPercent),
   }
 }
\`\`\``

describe('production capability isolated code runners', () => {
  it('extracts and executes only the allowlisted Python test command', async () => {
    await assertPythonTestRuntimeAvailable()
    expect(extractPythonBlocks(pythonAnswer)).toHaveLength(2)
    const result = await testGeneratedDiscountPython(pythonAnswer)
    expect(result.command).toBe('python -m pytest -q')
    expect(result.accepted, JSON.stringify(result)).toBe(true)
    expect(result.passed, JSON.stringify(result)).toBe(true)
  }, 20_000)

  it('rejects unsafe generated Python before execution', async () => {
    const result = await testGeneratedDiscountPython(
      pythonAnswer.replace('from decimal import Decimal, ROUND_HALF_UP', 'import os'),
    )
    expect(result.accepted).toBe(false)
    expect(result.reasonCode).toMatch(/unsafe|import/)
  })

  it('validates, applies, and tests an allowlisted repository patch', async () => {
    const diff = extractUnifiedDiff(patchAnswer)
    expect(diff).not.toBeNull()
    expect(validateRepositoryDiff(diff!)).toBeNull()
    const result = await testRepositoryPatch(patchAnswer)
    expect(result.command).toBe('npm test')
    expect(result.accepted, JSON.stringify(result)).toBe(true)
    expect(result.passed, JSON.stringify(result)).toBe(true)
  }, 25_000)

  it('applies a fenced repository patch when a grounding warning follows it', async () => {
    const result = await testRepositoryPatch(
      `${patchAnswer}\n\nRepository path verification could not verify: \`src/missing.js\`.`,
    )
    expect(result.accepted, JSON.stringify(result)).toBe(true)
    expect(result.passed, JSON.stringify(result)).toBe(true)
  }, 25_000)

  it('safely recounts stale unified-diff hunk sizes before applying', async () => {
    const staleCounts = patchAnswer.replace('@@ -5,5 +5,8 @@', '@@ -5,5 +5,99 @@')
    const result = await testRepositoryPatch(staleCounts)
    expect(result.accepted, JSON.stringify(result)).toBe(true)
    expect(result.passed, JSON.stringify(result)).toBe(true)
  }, 25_000)

  it('restores omitted unified-diff context markers before isolated apply', async () => {
    const malformed = patchAnswer
      .replace("\n import { finalPrice }", "\nimport { finalPrice }")
    const extracted = extractUnifiedDiff(malformed)!
    expect(normalizeGeneratedUnifiedDiff(extracted)).toContain(
      '\n import { finalPrice }',
    )
    const result = await testRepositoryPatch(malformed)
    expect(result.accepted, JSON.stringify(result)).toBe(true)
    expect(result.passed, JSON.stringify(result)).toBe(true)
  }, 25_000)

  it('rejects package and traversal modifications', () => {
    expect(validateRepositoryDiff('--- a/package.json\n+++ b/package.json\n'))
      .toBe('repository_forbidden_patch_content')
    expect(validateRepositoryDiff('--- a/../secret\n+++ b/../secret\n'))
      .toBe('repository_path_traversal')
  })
})
