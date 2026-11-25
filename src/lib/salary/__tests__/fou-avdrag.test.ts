import { describe, it, expect } from 'vitest'
import {
  avgiftDeductionsForRun,
  computeFouAvdrag,
  fouEmployeeIds,
  FOU_AVDRAG_MAX_PER_PERIOD,
} from '../fou-avdrag'
import type { DeclaredAvgifterRunRow } from '../declared-avgifter'

// FoU-avdrag: lag (2023:747) 6-8 §§, Skatteverket kontroller S_102/S_104,
// S_194 (FK475 <= 20 % of FK470, <= 3 000 000 kr) and B_001 (FK470 only
// full-rate underlag).

const PARAMS = { avgifterTotal: 0.3142, avgifterAlderspension: 0.1021, avgifterYouthSalaryCap: 25000 }

const row = (over: Partial<Parameters<typeof computeFouAvdrag>[0][number]> = {}) => ({
  basis: 40000,
  rate: 0.3142,
  category: 'standard' as string | null,
  overrideAmount: null as number | null,
  employeeId: 'ceo' as string | null,
  ...over,
})
const eligible = new Set(['ceo'])

describe('computeFouAvdrag', () => {
  it('deducts 20 % of the eligible underlag, öretal dropped', () => {
    expect(computeFouAvdrag([row()], eligible, PARAMS)).toEqual({ underlag: 40000, deduction: 8000 })
    expect(computeFouAvdrag([row({ basis: 12345.67 })], eligible, PARAMS)).toEqual({ underlag: 12345, deduction: 2469 })
  })

  it('counts only employees in the snapshot', () => {
    expect(computeFouAvdrag([row(), row({ employeeId: 'sales' })], eligible, PARAMS)).toEqual({
      underlag: 40000,
      deduction: 8000,
    })
    expect(computeFouAvdrag([row({ employeeId: null })], eligible, PARAMS)).toBeNull()
    expect(computeFouAvdrag([row()], new Set(), PARAMS)).toBeNull()
  })

  it('caps the avdrag at 3 000 000 kr per month but declares the whole underlag', () => {
    const rows = Array.from({ length: 200 }, (_, i) => row({ basis: 100000, employeeId: `e${i}` }))
    const ids = new Set(rows.map((r) => r.employeeId as string))
    expect(computeFouAvdrag(rows, ids, PARAMS)).toEqual({ underlag: 20_000_000, deduction: FOU_AVDRAG_MAX_PER_PERIOD })
  })

  it('leaves out 67+ rows, rows without avgift and manual avgift overrides', () => {
    expect(
      computeFouAvdrag(
        [
          row({ rate: 0.1021, category: 'reduced_65plus' }),
          row({ rate: 0, category: 'exempt' }),
          row({ basis: 0 }),
          row({ overrideAmount: 4568 }),
        ],
        eligible,
        PARAMS,
      ),
    ).toBeNull()
  })

  it('counts only the full-rate part of a youth payslip (B_001)', () => {
    expect(computeFouAvdrag([row({ basis: 30000, rate: 0.2081, category: 'youth' })], eligible, PARAMS)).toEqual({
      underlag: 5000,
      deduction: 1000,
    })
    expect(computeFouAvdrag([row({ basis: 20000, rate: 0.2081, category: 'youth' })], eligible, PARAMS)).toBeNull()
  })

  it('never takes the avgift below the ålderspensionsavgift', () => {
    // A hypothetical full sats of 25 % leaves 25 - 10,21 = 14,79 % of room.
    expect(computeFouAvdrag([row()], eligible, { ...PARAMS, avgifterTotal: 0.25 })).toEqual({
      underlag: 40000,
      deduction: 5916,
    })
  })
})

describe('fouEmployeeIds', () => {
  it('reads the frozen ids and ignores anything else', () => {
    expect([...fouEmployeeIds({ salary_fou_employee_ids: ['a', 1, null, 'b'] })]).toEqual(['a', 'b'])
    expect(fouEmployeeIds({ salary_fou_employee_ids: 'a' }).size).toBe(0)
    expect(fouEmployeeIds(null).size).toBe(0)
  })
})

describe('avgiftDeductionsForRun', () => {
  const runRow = (over: Partial<DeclaredAvgifterRunRow> = {}): DeclaredAvgifterRunRow => ({
    employee_id: 'ceo',
    avgifter_basis: 40000,
    avgifter_rate: 0.3142,
    avgifter_category: 'standard',
    ...over,
  })

  it('is nothing unless the snapshot names the employee', () => {
    expect(avgiftDeductionsForRun([runRow()], PARAMS)).toEqual({ fou: null, regional: null, total: 0 })
  })

  it('reads the rows the AGI declares: borttag and F-skatt rows form no underlag', () => {
    const params = { ...PARAMS, salary_fou_employee_ids: ['ceo'] }
    expect(avgiftDeductionsForRun([runRow()], params).total).toBe(8000)
    expect(avgiftDeductionsForRun([runRow({ removed_from_agi: true })], params).fou).toBeNull()
    expect(avgiftDeductionsForRun([runRow({ employee: { f_skatt_status: 'f_skatt' } })], params).fou).toBeNull()
  })

  it('leaves regionalt stöd alone without a FoU-avdrag', () => {
    const result = avgiftDeductionsForRun([runRow({ employee_id: 'sales' })], {
      ...PARAMS,
      salary_regional_support: true,
      salary_fou_employee_ids: ['ceo'],
    })
    expect(result).toEqual({ fou: null, regional: { underlag: 40000, deduction: 4000 }, total: 4000 })
  })

  it('takes the FoU-avdrag first and caps regionalt stöd at the ålderspensionsavgift (lag 2001:1170 5 och 7 §§)', () => {
    const result = avgiftDeductionsForRun([runRow()], {
      ...PARAMS,
      salary_regional_support: true,
      salary_fou_employee_ids: ['ceo'],
    })
    // 12 568 - 8 000 - ceil(40 000 × 10,21 %) = 484.
    expect(result).toEqual({
      fou: { underlag: 40000, deduction: 8000 },
      regional: { underlag: 40000, deduction: 484 },
      total: 8484,
    })
  })
})
