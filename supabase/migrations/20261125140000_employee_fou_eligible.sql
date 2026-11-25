-- FoU-avdrag: the särskilt avdrag from arbetsgivaravgifterna for ersättning
-- to a person who works with forskning eller utveckling (lagen (2023:747),
-- 6-8 §§).
--
-- The company attests per employee that the person, in the months the
-- company pays salary, works with forskning eller utveckling at least half
-- and at least 15 hours of the actual working time (7 §). When on, a salary
-- run calculated afterwards snapshots the employee into
-- salary_runs.calculation_params, its AGI declares FK470 UlagFoU and FK475
-- AvdragFoU (20 % of the underlag, at most 3 000 000 kr per month), and its
-- booking credits the avdrag back on 7510 so 2731 equals the FK487
-- Skatteverket draws (lib/salary/fou-avdrag.ts).
--
-- DEFAULT false: every existing employee and run is unchanged.

ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS fou_eligible boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.employees.fou_eligible IS
  'FoU-avdrag: the person works with forskning eller utveckling (lag 2023:747 7 §). New salary runs declare FK470/FK475 and book the avdrag.';

-- The behandlingshistorik pay-basis audit records a change of the flag like
-- the other pay-basis columns (EMPLOYEE_PAY_FIELDS in
-- src/lib/reports/behandlingshistorik.ts; a unit test compares the lists).
-- The function below is 20261101003400's with 'fou_eligible' added to
-- c_pay_keys, nothing else changed.

CREATE OR REPLACE FUNCTION public.audit_employee_pay_basis()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  -- The pay basis. Keep in step with EMPLOYEE_PAY_FIELDS in
  -- src/lib/reports/behandlingshistorik.ts (a unit test compares them).
  c_pay_keys CONSTANT text[] := ARRAY[
    'employment_type', 'personnel_category', 'employment_start', 'employment_end',
    'employment_degree', 'hours_per_week', 'workdays_per_week',
    'salary_type', 'monthly_salary', 'hourly_rate',
    'tax_table_number', 'tax_column', 'is_sidoinkomst',
    'jamkning_percentage', 'jamkning_valid_from', 'jamkning_valid_to',
    'extra_tax_amount', 'extra_tax_percentage',
    'f_skatt_status', 'f_skatt_verified_at',
    'vacation_rule', 'vacation_days_per_year', 'vacation_days_saved',
    'vacation_pay_rate', 'semestertillagg_rate',
    'housing_benefit_type', 'vaxa_stod_eligible', 'vaxa_stod_start', 'vaxa_stod_end', 'fou_eligible',
    'fora_fok_id', 'fora_fok_start_date', 'default_dimensions', 'is_active'];
  -- Whose pay it is: stored with the pay basis, never compared.
  c_identity_keys CONSTANT text[] := ARRAY['first_name', 'last_name'];
  v_old_state   jsonb;
  v_new_state   jsonb;
  v_user_id     uuid;
  v_session     uuid;
  v_actor_type  text;
  v_actor_label text;
  v_request     record;
BEGIN
  -- Same teardown guard as write_audit_log() (20260807130000).
  IF current_setting('gnubok.sandbox_cleanup', true) = 'true' THEN
    RETURN NEW;
  END IF;

  SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
    INTO v_new_state
    FROM jsonb_each(to_jsonb(NEW)) e
   WHERE e.key = ANY (c_pay_keys || c_identity_keys);

  IF TG_OP = 'UPDATE' THEN
    SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
      INTO v_old_state
      FROM jsonb_each(to_jsonb(OLD)) e
     WHERE e.key = ANY (c_pay_keys || c_identity_keys);
    -- An edit of the address, bank account, e-mail or name only: no pay
    -- basis changed, nothing to log.
    IF (v_old_state - c_identity_keys) = (v_new_state - c_identity_keys) THEN
      RETURN NEW;
    END IF;
  END IF;

  -- WHO, as in write_audit_log (20261031202000): the session's user, else the
  -- person a service-role request acts for, else the row's user_id; the
  -- credential the RPC was handed, else the request's, else 'user'.
  v_user_id := NEW.user_id;
  v_actor_type := nullif(current_setting('gnubok.actor_type', true), '');
  v_actor_label := nullif(current_setting('gnubok.actor_label', true), '');
  v_session := auth.uid();
  IF v_session IS NOT NULL THEN
    v_user_id := v_session;
  ELSE
    SELECT r.user_id, r.actor_type, r.actor_label INTO v_request
      FROM public.service_request_actor() r;
    v_user_id := COALESCE(v_request.user_id, v_user_id);
    IF v_actor_type IS NULL AND v_request.actor_type IS NOT NULL THEN
      v_actor_type := v_request.actor_type;
      v_actor_label := v_request.actor_label;
    END IF;
  END IF;

  INSERT INTO public.audit_log (
    user_id, company_id, action, table_name, record_id, actor_id,
    old_state, new_state, description, actor_type, actor_label
  )
  VALUES (
    v_user_id, NEW.company_id, TG_OP, TG_TABLE_NAME, NEW.id, v_user_id,
    v_old_state, v_new_state,
    CASE TG_OP WHEN 'INSERT' THEN 'Created employee pay basis' ELSE 'Updated employee pay basis' END,
    COALESCE(v_actor_type, 'user'),
    v_actor_label
  );

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.audit_employee_pay_basis() IS
  'Behandlingshistorik for employees (accounted#30): writes the pay-basis columns and the name, old and new, to audit_log on INSERT and on an UPDATE that changes one of them. Never the personnummer, bank account, address or contact details. Actor as write_audit_log().';

REVOKE EXECUTE ON FUNCTION public.audit_employee_pay_basis() FROM PUBLIC, anon, authenticated;
