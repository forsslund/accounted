import { truncateToWholeKronor } from '@/lib/money'
import {
  declaredAvgifterForRun,
  declaredAvgifterRowsForRun,
  reportingCategory,
  resolveDeclaredAvgifterParams,
  type DeclaredAvgifterHybridRow,
  type DeclaredAvgifterRunRow,
} from './declared-avgifter'
import { computeRegionalSupport, regionalSupportEnabled, type RegionalSupport } from './regional-support'

/**
 * FoU-avdrag: the särskilt avdrag from arbetsgivaravgifterna for ersättning
 * to a person who works with forskning eller utveckling.
 *
 * Law: lagen (2023:747) om särskilt avdrag vid beräkning av
 * arbetsgivaravgifter och allmän löneavgift för personer som arbetar med
 * forskning eller utveckling, in force from 2024-01-01:
 *  - 6 §: the avdrag applies to avgiftspliktig ersättning to the person,
 *    except ersättning on which only ålderspensionsavgift is paid (2 kap.
 *    27 § socialavgiftslagen: 67 or older at the start of the year);
 *  - 7 §: only for a calendar month in which the person worked with FoU for
 *    at least half and at least 15 hours of the actual working time (or
 *    did so in each of the four months before, unless the duties changed);
 *  - 8 §: 20 % of the avgiftsunderlag, never below the ålderspensionsavgift
 *    (2 kap. 26 § socialavgiftslagen), at most 3 000 000 kr per calendar
 *    month for all such persons (one avgiftsskyldig per koncern).
 * The company attests the 7 § condition per employee with
 * employees.fou_eligible; the eligible employees are frozen into the run's
 * calculation_params at :calculate (FOU_EMPLOYEES_PARAM), so the booking and
 * the AGI of one run always read the same answer.
 *
 * AGI (Skatteverket, Teknisk beskrivning 1.1.18.1: Bilaga Fältlista,
 * Kontroller, Summering och beräkningsregler): HU fields UlagFoU FK470 and
 * AvdragFoU FK475, both or neither (S_102, S_104); FK475 at most 20 % of
 * FK470 (P_070), at most FK470 and at most 3 000 000 kr (S_194); FK470 at
 * most the full-rate underlag (B_001: FK420 and the utsänd counterparts).
 * Skatteverket's computed avgift IK587 subtracts FK475 and the filed FK487
 * must equal it (B_006), so FK487, the booked 2731 and the payment are the
 * avgift AFTER the avdrag. IK587 must stay at least the
 * ålderspensionsavgift on the underlag (B_014).
 *
 * Combination with regionalt stöd (lag 2001:1170 7 §): the FoU-avdrag is
 * made first; the regionalt stöd is then capped so the avgift after both
 * stays at or above the ålderspensionsavgift (5 § of that lag, B_014).
 *
 * Not covered (follow-up): an employer without a fast driftställe in
 * Sweden (FK302, P_071 8,59 %), a cap shared inside a koncern, and youth
 * rows' reduced-rate part (B_001 admits only full-rate underlag; the part
 * of a youth payslip above the cap is full rate and does count).
 */

/** Avdrag in percent of the underlag (lag 2023:747 8 §, Skatteverket P_070). */
export const FOU_AVDRAG_PERCENT = 20

/** Highest avdrag per calendar month, whole kronor (8 §, kontroll S_194). */
export const FOU_AVDRAG_MAX_PER_PERIOD = 3_000_000

/** The key the run's calculation_params snapshot carries the eligible employee ids under. */
export const FOU_EMPLOYEES_PARAM = 'salary_fou_employee_ids'

export interface FouAvdrag {
  /** FK470 UlagFoU, whole kronor. */
  underlag: number
  /** FK475 AvdragFoU, whole kronor, at most FOU_AVDRAG_MAX_PER_PERIOD. */
  deduction: number
}

/** The employee ids the run was calculated with as FoU-eligible (its frozen snapshot). */
export function fouEmployeeIds(calculationParams: Record<string, unknown> | null | undefined): Set<string> {
  const ids = calculationParams?.[FOU_EMPLOYEES_PARAM]
  return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [])
}

/**
 * FK470 and FK475 for one run's rows, or null when nothing qualifies.
 *
 * A row of an eligible employee forms underlag with the part charged at the
 * full sats (B_001): a standard row whole, a youth row only above the youth
 * cap. Left out: 65+-reduced rows (6 § second stycket), rows with no avgift
 * (exempt, F-skatt at basis 0) and rows with a manual
 * avgifter_amount_override (the operator's number may already carry a
 * reduction; leaving them out can only under-claim). Underlag is whole
 * kronor per row, the avdrag 20 % of it with öretal dropped, never more than
 * the avgift above the ålderspensionsavgift, capped per period.
 */
export function computeFouAvdrag(
  rows: DeclaredAvgifterHybridRow[],
  eligibleEmployeeIds: ReadonlySet<string>,
  calculationParams: Record<string, unknown> | null | undefined,
): FouAvdrag | null {
  if (eligibleEmployeeIds.size === 0) return null
  const { standardRate, youthCap } = resolveDeclaredAvgifterParams(calculationParams)
  let underlag = 0
  for (const row of rows) {
    if (!row.employeeId || !eligibleEmployeeIds.has(row.employeeId)) continue
    if (row.overrideAmount != null) continue
    if (!(row.rate > 0)) continue
    const category = reportingCategory(row)
    const rowUnderlag = truncateToWholeKronor(row.basis)
    if (rowUnderlag <= 0) continue
    if (category === 'standard') underlag += rowUnderlag
    else if (category === 'youth' && youthCap !== null) underlag += Math.max(rowUnderlag - Math.trunc(youthCap), 0)
  }
  // The ålderspensionsavgift floor (8 § second sentence): on full-rate
  // underlag the 20 % never reaches it (31,42 % less 10,21 %), but the
  // sats come from the run's snapshot, so the floor is applied, not assumed.
  const alderspension = alderspensionRate(calculationParams)
  const room = Math.trunc((underlag * Math.round((standardRate - alderspension) * 10_000)) / 10_000)
  const deduction = Math.max(
    Math.min(Math.trunc((underlag * FOU_AVDRAG_PERCENT) / 100), room, FOU_AVDRAG_MAX_PER_PERIOD),
    0,
  )
  return deduction > 0 ? { underlag, deduction } : null
}

/** The ålderspensionsavgift sats from the run's snapshot (2 kap. 26 § socialavgiftslagen). */
function alderspensionRate(calculationParams: Record<string, unknown> | null | undefined): number {
  const value = calculationParams?.['avgifterAlderspension']
  return typeof value === 'number' && Number.isFinite(value) ? value : 0.1021
}

export interface AvgiftDeductions {
  /** FK470/FK475, null when the run claims no FoU-avdrag. */
  fou: FouAvdrag | null
  /** FK471/FK476, null when the run claims no regionalt stöd. */
  regional: RegionalSupport | null
  /** FK475 + FK476: what FK487, the booked 2731 and the payment are lowered by. */
  total: number
}

/**
 * Both särskilda avdrag of one run, from rows read the way the declared
 * avgifter read them. The FoU-avdrag goes first (lag 2001:1170 7 §); the
 * regionalt stöd is then capped so the avgift after both is at least the
 * ålderspensionsavgift on the declared underlag (lag 2001:1170 5 §, B_014).
 * Rounding the floor up and counting all underlag can only under-claim.
 */
export function computeAvgiftDeductions(
  rows: DeclaredAvgifterHybridRow[],
  calculationParams: Record<string, unknown> | null | undefined,
  declared: { totalAmount: number; totalUnderlag: number },
): AvgiftDeductions {
  const fou = computeFouAvdrag(rows, fouEmployeeIds(calculationParams), calculationParams)
  let regional = regionalSupportEnabled(calculationParams) ? computeRegionalSupport(rows) : null
  if (regional && fou) {
    const floor = Math.ceil((declared.totalUnderlag * Math.round(alderspensionRate(calculationParams) * 10_000)) / 10_000)
    const room = Math.max(declared.totalAmount - fou.deduction - floor, 0)
    regional = room > 0 ? { underlag: regional.underlag, deduction: Math.min(regional.deduction, room) } : null
  }
  return { fou, regional, total: (fou?.deduction ?? 0) + (regional?.deduction ?? 0) }
}

/**
 * The särskilda avdrag a run's AGI declares, from the stored roster rows
 * (declaredAvgifterRowsForRun), next to the FK487 before them.
 */
export function avgiftDeductionsForRun(
  rows: DeclaredAvgifterRunRow[],
  calculationParams: Record<string, unknown> | null | undefined,
): AvgiftDeductions {
  return computeAvgiftDeductions(
    declaredAvgifterRowsForRun(rows),
    calculationParams,
    declaredAvgifterForRun(rows, calculationParams),
  )
}
