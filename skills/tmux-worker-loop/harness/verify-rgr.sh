#!/usr/bin/env bash
# verify-rgr.sh v1
#
# WHY THIS EXISTS
# A hand-written RGR log can claim trees and test results that never existed.
# This gate re-derives mechanical evidence from anchored Git objects before
# Main may dispatch the semantic review.
# Thesis: nothing in rgr.log is trusted. Every evidence field is either a Git
# object id that exists in the object database or a scalar re-derived from one.
# The report names both covered and not-covered dimensions; the latter remain
# mandatory work for the independent Reviewer, never implied by RESULT: PASS.
#
# MAIN-DECLARED EXCEPTIONS
# --allow-outside, --frontier, and --debt are one argv-only family:
#   --<type> <subject> [--scope key=value]... --reason <text>
# Every declaration requires a reason, is bounded by its type-specific scope,
# and appears in one report section. None may come from rgr.log: letting the
# audited record declare its own exception would let it excuse itself.
# An allow-outside declaration must consume a measured production violation.
# Historical intervals are immutable; dynamic or broad scopes additionally
# require to-tree=<sha>, binding the permission to the exact observed tree.
# A frontier declares a closed past, never a future. Moving it forward signals
# that the evidence requirement is not implementable and requires discussion,
# not another routine exception.
# This rule first existed only in prose; an oversized frontier then made a real
# late evidence regression pass. Therefore the gate itself requires the exact
# contiguous missing prefix and rejects both anchored and not-yet-existing cycles.
# Frontier dimensions use the same canonical names as their evidence contract:
# env, suite-exits, suite-status, and catches. The legacy suite-exit argv alias
# is accepted only for compatibility and is reported as suite-exits with a warning.
#
# Usage: verify-rgr.sh [--<type> <subject> [--scope key=value]... --reason <text>]...
# Env: CYCLE_DIR must name the cycle artifacts directory.

set -u

script_dir=$(cd "$(dirname "$0")" && pwd -P)
. "$script_dir/rgr-log.sh"

usage_error() {
  usage_message=$1
  echo "$usage_message" >&2
  if [ -n "${CYCLE_DIR:-}" ] && [ -d "$CYCLE_DIR" ]; then
    usage_cycle_dir=$(cd "$CYCLE_DIR" && pwd -P 2>/dev/null)
    if [ -n "$usage_cycle_dir" ]; then
      {
        printf '%s\n' '## GATE' 'RESULT: USAGE-ERROR' 'exit=1'
        printf 'reason="%s"\n' "$usage_message"
      } > "$usage_cycle_dir/verify-rgr.md"
    fi
  fi
  exit 1
}

allow_outside_paths=()
allow_outside_slots=()
allow_outside_intervals=()
allow_outside_to_trees=()
allow_outside_reasons=()
allow_outside_consumed=()
frontier_dimensions=()
frontier_until_cycles=()
frontier_reasons=()
frontier_valid=()
debt_subjects=()
debt_cycles=()
debt_reasons=()
declaration_types=()
declaration_subjects=()
declaration_scopes=()
declaration_reasons=()
declaration_alias_warnings=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --allow-outside|--frontier|--debt)
      declaration_flag=$1
      declaration_type=${declaration_flag#--}
      declaration_usage="verify-rgr: $declaration_flag requires <subject> [--scope key=value]... --reason <reason>"
      [ "$#" -ge 2 ] && [ -n "$2" ] || usage_error "$declaration_usage"
      declaration_subject=$2
      declaration_scope=''
      declaration_allow_slot=''
      declaration_allow_interval=''
      declaration_allow_to_tree=''
      declaration_frontier_until=''
      declaration_debt_cycle=''
      shift 2
      while [ "${1:-}" = --scope ]; do
        [ "$#" -ge 2 ] && [ -n "$2" ] || usage_error "$declaration_usage"
        declaration_scope_key=${2%%=*}
        declaration_scope_value=${2#*=}
        [ "$declaration_scope_key" != "$2" ] && [ -n "$declaration_scope_key" ] \
          && [ -n "$declaration_scope_value" ] || usage_error "$declaration_usage"
        case "$declaration_type:$declaration_scope_key" in
          allow-outside:slot)
            [ -z "$declaration_allow_slot" ] || usage_error "$declaration_usage"
            declaration_allow_slot=$declaration_scope_value
            ;;
          allow-outside:interval)
            [ -z "$declaration_allow_interval" ] || usage_error "$declaration_usage"
            declaration_allow_interval=$declaration_scope_value
            ;;
          allow-outside:to-tree)
            [ -z "$declaration_allow_to_tree" ] || usage_error "$declaration_usage"
            case "$declaration_scope_value" in *[!0-9a-f]*|'') usage_error "$declaration_usage" ;; esac
            [ "${#declaration_scope_value}" -eq 40 ] || usage_error "$declaration_usage"
            declaration_allow_to_tree=$declaration_scope_value
            ;;
          frontier:until-cycle)
            [ -z "$declaration_frontier_until" ] || usage_error "$declaration_usage"
            case "$declaration_scope_value" in *[!0-9]*|'') usage_error "$declaration_usage" ;; esac
            declaration_frontier_until=$declaration_scope_value
            ;;
          debt:cycle)
            [ -z "$declaration_debt_cycle" ] || usage_error "$declaration_usage"
            case "$declaration_scope_value" in *[!0-9]*|''|0) usage_error "$declaration_usage" ;; esac
            declaration_debt_cycle=$declaration_scope_value
            ;;
          *) usage_error "$declaration_usage" ;;
        esac
        declaration_scope="${declaration_scope}${declaration_scope:+,}${2}"
        shift 2
      done
      [ "$#" -ge 2 ] && [ "$1" = --reason ] && [ -n "$2" ] \
        || usage_error "$declaration_usage"
      declaration_reason=$2
      shift 2
      case "$declaration_type" in
        allow-outside)
          allow_outside_paths+=("$declaration_subject")
          allow_outside_slots+=("$declaration_allow_slot")
          allow_outside_intervals+=("$declaration_allow_interval")
          allow_outside_to_trees+=("$declaration_allow_to_tree")
          allow_outside_reasons+=("$declaration_reason")
          allow_outside_consumed+=(no)
          [ -n "$declaration_scope" ] || declaration_scope=broad
          ;;
        frontier)
          if [ "$declaration_subject" = suite-exit ]; then
            declaration_alias_warnings+=("warning declaration alias=suite-exit canonical=suite-exits")
            declaration_subject=suite-exits
          fi
          case "$declaration_subject" in env|suite-exits|suite-status|catches) ;; *) usage_error "$declaration_usage" ;; esac
          [ -n "$declaration_frontier_until" ] || usage_error "$declaration_usage"
          frontier_dimensions+=("$declaration_subject")
          frontier_until_cycles+=("$declaration_frontier_until")
          frontier_reasons+=("$declaration_reason")
          ;;
        debt)
          [ "$declaration_subject" = refactor-equivalence ] \
            && [ -n "$declaration_debt_cycle" ] || usage_error "$declaration_usage"
          debt_subjects+=("$declaration_subject")
          debt_cycles+=("$declaration_debt_cycle")
          debt_reasons+=("$declaration_reason")
          ;;
      esac
      declaration_types+=("$declaration_type")
      declaration_subjects+=("$declaration_subject")
      declaration_scopes+=("$declaration_scope")
      declaration_reasons+=("$declaration_reason")
      ;;
    *) usage_error "verify-rgr: unknown argument: $1" ;;
  esac
done

die() {
  echo "verify-rgr: $1" >&2
  exit "${2:-1}"
}

[ -n "${CYCLE_DIR:-}" ] || die "CYCLE_DIR unset; export the cycle artifacts directory"
[ -d "$CYCLE_DIR" ] || die "CYCLE_DIR does not exist: $CYCLE_DIR"
CYCLE_DIR=$(cd "$CYCLE_DIR" && pwd -P) || die "cannot resolve CYCLE_DIR"
log_file="$CYCLE_DIR/rgr.log"
[ -f "$log_file" ] || die "missing $log_file; no RGR evidence exists"
rgr_log_validate_header "$log_file" \
  || die "pre-harness log found; expected RGRLOG v1 before mechanical verification"

cycle_id=$(basename "$CYCLE_DIR")
cycle_id=${cycle_id#tmux-worker-cycle-}
worktrees_file="$CYCLE_DIR/worktrees.env"
[ -f "$worktrees_file" ] || die "missing $worktrees_file; cannot resolve cycle repositories"
report_file="$CYCLE_DIR/verify-rgr.md"
violations_file=$(mktemp "$CYCLE_DIR/.verify-rgr-violations.XXXXXX") \
  || die "cannot create gate diagnostics"
: > "$violations_file"
warnings_file=$(mktemp "$CYCLE_DIR/.verify-rgr-warnings.XXXXXX") \
  || die "cannot create gate warnings"
: > "$warnings_file"

violate() {
  printf '%s\n' "$1" >> "$violations_file"
}

warn() {
  printf '%s\n' "$1" >> "$warnings_file"
}

declaration_alias_warning_index=0
while [ "$declaration_alias_warning_index" -lt "${#declaration_alias_warnings[@]}" ]; do
  warn "${declaration_alias_warnings[$declaration_alias_warning_index]}"
  declaration_alias_warning_index=$((declaration_alias_warning_index + 1))
done

outside_scope_slots=()
outside_scope_intervals=()
outside_scope_to_trees=()

summarize_cycle_ranges() {
  printf '%s\n' $1 | awk '
    NR == 1 { start = previous = $1; next }
    $1 == previous + 1 { previous = $1; next }
    {
      range = start == previous ? start : start "-" previous
      output = output == "" ? range : output "," range
      start = previous = $1
    }
    END {
      if (NR > 0) {
        range = start == previous ? start : start "-" previous
        output = output == "" ? range : output "," range
      }
      print output
    }
  '
}

frontier_authorizes() {
  frontier_candidate_dimension=$1
  frontier_candidate_cycle=$2
  frontier_index=0
  while [ "$frontier_index" -lt "${#frontier_dimensions[@]}" ]; do
    if [ "${frontier_valid[$frontier_index]}" = yes ] \
      && [ "$frontier_candidate_dimension" = "${frontier_dimensions[$frontier_index]}" ] \
      && [ "$frontier_candidate_cycle" -le "${frontier_until_cycles[$frontier_index]}" ]; then
      return 0
    fi
    frontier_index=$((frontier_index + 1))
  done
  return 1
}

discover_first_anchored_evidence_cycles() {
  first_env_evidence_cycle=''
  first_suite_exit_evidence_cycle=''
  first_suite_status_evidence_cycle=''
  first_catches_evidence_cycle=''
  for evidence_cycle in $cycle_numbers; do
    evidence_header=$(rgr_log_cycle_header "$log_file" "$evidence_cycle" 2>/dev/null || true)
    evidence_green=$(rgr_log_phase_line "$log_file" "$evidence_cycle" GREEN 2>/dev/null || true)
    evidence_catches=$(rgr_log_phase_line "$log_file" "$evidence_cycle" CATCHES 2>/dev/null || true)
    evidence_refactor=$(rgr_log_phase_line "$log_file" "$evidence_cycle" REFACTOR 2>/dev/null || true)
    if [ -z "$first_env_evidence_cycle" ]; then
      evidence_env=$(rgr_log_plain_field "$evidence_header" env 2>/dev/null || true)
      if [ -n "$evidence_env" ] && [ "$evidence_env" != unverifiable ]; then
        first_env_evidence_cycle=$evidence_cycle
      fi
    fi
    if [ -z "$first_suite_exit_evidence_cycle" ] \
      && [ -n "$(rgr_log_indexed_fields "$evidence_green" suite-exit-)" ] \
      && [ -n "$(rgr_log_indexed_fields "$evidence_refactor" suite-exit-)" ]; then
      first_suite_exit_evidence_cycle=$evidence_cycle
    fi
    if [ -z "$first_suite_status_evidence_cycle" ] \
      && [ -n "$(rgr_log_indexed_fields "$evidence_green" status-suite-)" ] \
      && [ -n "$(rgr_log_indexed_fields "$evidence_refactor" status-suite-)" ]; then
      first_suite_status_evidence_cycle=$evidence_cycle
    fi
    if [ -z "$first_catches_evidence_cycle" ]; then
      evidence_catches_value=$(rgr_log_plain_field "$evidence_catches" catches 2>/dev/null || true)
      evidence_catches_run=$(rgr_log_plain_field "$evidence_catches" run-targeted 2>/dev/null || true)
      case "$evidence_catches_value" in
        yes|no) [ -z "$evidence_catches_run" ] || first_catches_evidence_cycle=$evidence_cycle ;;
      esac
    fi
    if [ -n "$first_env_evidence_cycle" ] && [ -n "$first_suite_exit_evidence_cycle" ] \
      && [ -n "$first_suite_status_evidence_cycle" ] && [ -n "$first_catches_evidence_cycle" ]; then
      return
    fi
  done
}

frontier_first_evidence_cycle() {
  case "$1" in
    env) printf '%s\n' "$first_env_evidence_cycle" ;;
    suite-exits) printf '%s\n' "$first_suite_exit_evidence_cycle" ;;
    suite-status) printf '%s\n' "$first_suite_status_evidence_cycle" ;;
    catches) printf '%s\n' "$first_catches_evidence_cycle" ;;
  esac
}

validate_frontier_declarations() {
  last_logged_cycle=0
  for frontier_logged_cycle in $cycle_numbers; do
    last_logged_cycle=$frontier_logged_cycle
  done
  frontier_index=0
  while [ "$frontier_index" -lt "${#frontier_dimensions[@]}" ]; do
    frontier_valid[$frontier_index]=no
    frontier_dimension=${frontier_dimensions[$frontier_index]}
    frontier_until=${frontier_until_cycles[$frontier_index]}
    frontier_first=$(frontier_first_evidence_cycle "$frontier_dimension")
    if [ "$frontier_until" -gt "$last_logged_cycle" ]; then
      violate "check=declaration type=frontier subject=$frontier_dimension scope=until-cycle=$frontier_until error=future-cycle-boundary last-cycle=$last_logged_cycle"
    elif [ -n "$frontier_first" ] && [ "$frontier_until" -ge "$frontier_first" ]; then
      violate "check=declaration type=frontier subject=$frontier_dimension scope=until-cycle=$frontier_until error=anchored-evidence-conflict detail=\"evidence exists at cycle $frontier_first; frontier cannot cover it\""
    else
      if [ -n "$frontier_first" ]; then
        frontier_expected=$((frontier_first - 1))
      else
        frontier_expected=$last_logged_cycle
      fi
      if [ "$frontier_expected" -eq 0 ]; then
        violate "check=declaration type=frontier subject=$frontier_dimension scope=until-cycle=$frontier_until error=unused-frontier"
      elif [ "$frontier_until" -ne "$frontier_expected" ]; then
        violate "check=declaration type=frontier subject=$frontier_dimension scope=until-cycle=$frontier_until error=historical-prefix-mismatch expected-until-cycle=$frontier_expected"
      else
        frontier_valid[$frontier_index]=yes
      fi
    fi
    frontier_index=$((frontier_index + 1))
  done
}

record_unverified_cycle() {
  unverified_dimension=$1
  unverified_cycle=$2
  first_evidence_cycle=$(frontier_first_evidence_cycle "$unverified_dimension")
  if [ -n "$first_evidence_cycle" ] && [ "$unverified_cycle" -ge "$first_evidence_cycle" ]; then
    violate "check=frontier dimension=$unverified_dimension cycle=$unverified_cycle error=evidence-regression first-anchored-cycle=$first_evidence_cycle"
    return
  fi
  if ! frontier_authorizes "$unverified_dimension" "$unverified_cycle"; then
    case " $frontier_violation_dimensions " in *" $unverified_dimension "*) return ;; esac
    frontier_violation_dimensions="${frontier_violation_dimensions}${frontier_violation_dimensions:+ }$unverified_dimension"
    if [ -n "$first_evidence_cycle" ]; then
      full_frontier_cycle=$((first_evidence_cycle - 1))
      violate "check=frontier dimension=$unverified_dimension cycle=$unverified_cycle error=undeclared-or-beyond-boundary remedy=\"--frontier $unverified_dimension --scope until-cycle=$full_frontier_cycle --reason <text>\""
    else
      violate "check=frontier dimension=$unverified_dimension cycle=$unverified_cycle error=undeclared-or-beyond-boundary evidence=\"no anchored evidence in any cycle\""
    fi
    return
  fi
  case "$unverified_dimension" in
    env) unverified_list=$env_unverifiable_cycles ;;
    suite-exits) unverified_list=$suite_exit_unverifiable_cycles ;;
    suite-status) unverified_list=$suite_status_unverifiable_cycles ;;
    catches) unverified_list=$catches_unverifiable_cycles ;;
  esac
  case " $unverified_list " in *" $unverified_cycle "*) return ;; esac
  unverified_list="${unverified_list}${unverified_list:+ }$unverified_cycle"
  case "$unverified_dimension" in
    env) env_unverifiable_cycles=$unverified_list ;;
    suite-exits) suite_exit_unverifiable_cycles=$unverified_list ;;
    suite-status) suite_status_unverifiable_cycles=$unverified_list ;;
    catches) catches_unverifiable_cycles=$unverified_list ;;
  esac
}

report_unverified_dimension() {
  unverified_dimension=$1
  unverified_cycles=$2
  [ -n "$unverified_cycles" ] || return
  unverified_ranges=$(summarize_cycle_ranges "$unverified_cycles")
  unverified_count=$(printf '%s\n' $unverified_cycles | wc -l | tr -d ' ')
  printf 'unverified dimension=%s cycles=%s count=%s\n' \
    "$unverified_dimension" "$unverified_ranges" "$unverified_count"
}

report_declared_exceptions() {
  printf '%s\n' 'DECLARED EXCEPTIONS'
  declaration_index=0
  if [ "${#declaration_types[@]}" -eq 0 ]; then
    printf '%s\n' 'none'
  fi
  while [ "$declaration_index" -lt "${#declaration_types[@]}" ]; do
    printf 'exception type=%s subject=%s scope=%s reason="%s"\n' \
      "${declaration_types[$declaration_index]}" "${declaration_subjects[$declaration_index]}" \
      "${declaration_scopes[$declaration_index]}" "${declaration_reasons[$declaration_index]}"
    declaration_index=$((declaration_index + 1))
  done
}

repo_for_slot() {
  awk -F= -v wanted="$1" '$1 == wanted { sub(/^[^=]*=/, ""); print; exit }' "$worktrees_file"
}

cycle_is_logged() {
  logged_wanted=$1
  for logged_cycle in $cycle_numbers; do
    [ "$logged_cycle" != "$logged_wanted" ] || return 0
  done
  return 1
}

register_outside_scope() {
  outside_scope_slots+=("$1")
  outside_scope_intervals+=("$2")
  outside_scope_to_trees+=("$3")
}

outside_interval_is_dynamic() {
  [ -z "$1" ] || [ "${1##*-to-}" = current ]
}

path_is_allowed_outside() {
  allowed_candidate=$1
  allowed_candidate_interval=$2
  allowed_candidate_slot=$3
  allowed_candidate_to_tree=$4
  allowed_index=0
  while [ "$allowed_index" -lt "${#allow_outside_paths[@]}" ]; do
    if [ "$allowed_candidate" = "${allow_outside_paths[$allowed_index]}" ]; then
      allowed_slot=${allow_outside_slots[$allowed_index]}
      allowed_interval=${allow_outside_intervals[$allowed_index]}
      allowed_to_tree=${allow_outside_to_trees[$allowed_index]}
      if { [ -z "$allowed_slot" ] || [ "$allowed_candidate_slot" = "$allowed_slot" ]; } \
        && { [ -z "$allowed_interval" ] || [ "$allowed_candidate_interval" = "$allowed_interval" ]; } \
        && { ! outside_interval_is_dynamic "$allowed_interval" \
          || { [ -n "$allowed_to_tree" ] && [ "$allowed_candidate_to_tree" = "$allowed_to_tree" ]; }; } \
        && { [ -z "$allowed_to_tree" ] || [ "$allowed_candidate_to_tree" = "$allowed_to_tree" ]; }; then
        allow_outside_consumed[$allowed_index]=yes
        return 0
      fi
    fi
    allowed_index=$((allowed_index + 1))
  done
  return 1
}

outside_scope_exists() {
  scope_wanted_slot=$1
  scope_wanted_interval=$2
  scope_index=0
  while [ "$scope_index" -lt "${#outside_scope_slots[@]}" ]; do
    if { [ -z "$scope_wanted_slot" ] || [ "$scope_wanted_slot" = "${outside_scope_slots[$scope_index]}" ]; } \
      && [ "$scope_wanted_interval" = "${outside_scope_intervals[$scope_index]}" ]; then
      return 0
    fi
    scope_index=$((scope_index + 1))
  done
  return 1
}

outside_dynamic_tree() {
  dynamic_wanted_slot=$1
  dynamic_wanted_interval=$2
  dynamic_index=0
  while [ "$dynamic_index" -lt "${#outside_scope_slots[@]}" ]; do
    dynamic_slot=${outside_scope_slots[$dynamic_index]}
    dynamic_interval=${outside_scope_intervals[$dynamic_index]}
    if [ "$dynamic_wanted_slot" = "$dynamic_slot" ] \
      && { { [ -n "$dynamic_wanted_interval" ] && [ "$dynamic_wanted_interval" = "$dynamic_interval" ]; } \
        || { [ -z "$dynamic_wanted_interval" ] && [ "${dynamic_interval##*-to-}" = current ]; }; }; then
      printf '%s\n' "${outside_scope_to_trees[$dynamic_index]}"
      return 0
    fi
    dynamic_index=$((dynamic_index + 1))
  done
  return 1
}

validate_allow_outside_declarations() {
  allow_index=0
  while [ "$allow_index" -lt "${#allow_outside_paths[@]}" ]; do
    allow_path=${allow_outside_paths[$allow_index]}
    allow_slot=${allow_outside_slots[$allow_index]}
    allow_interval=${allow_outside_intervals[$allow_index]}
    allow_to_tree=${allow_outside_to_trees[$allow_index]}
    allow_scope="${allow_slot:+slot=$allow_slot,}${allow_interval:+interval=$allow_interval,}${allow_to_tree:+to-tree=$allow_to_tree}"
    allow_scope=${allow_scope%,}
    [ -n "$allow_scope" ] || allow_scope=broad
    allow_invalid=no
    if [ -n "$allow_slot" ] && [ -z "$(repo_for_slot "$allow_slot")" ]; then
      violate "check=declaration type=allow-outside subject=$allow_path scope=$allow_scope error=unknown-slot slot=$allow_slot"
      allow_invalid=yes
    elif [ -n "$allow_interval" ] && ! outside_scope_exists "$allow_slot" "$allow_interval"; then
      violate "check=declaration type=allow-outside subject=$allow_path scope=$allow_scope error=unknown-interval last-cycle=$last_logged_cycle"
      allow_invalid=yes
    fi
    if outside_interval_is_dynamic "$allow_interval"; then
        if [ "$allow_invalid" = no ] && [ -z "$allow_slot" ]; then
          violate "check=declaration type=allow-outside subject=$allow_path scope=$allow_scope error=dynamic-scope-requires-slot"
          allow_invalid=yes
        fi
        if [ "$allow_invalid" = no ]; then
          allow_actual_tree=$(outside_dynamic_tree "$allow_slot" "$allow_interval" 2>/dev/null || true)
          if [ -z "$allow_to_tree" ]; then
            if [ -n "$allow_interval" ]; then
              allow_interval_remedy=" --scope interval=$allow_interval"
            else
              allow_interval_remedy=''
            fi
            violate "check=declaration type=allow-outside subject=$allow_path scope=$allow_scope error=missing-to-tree actual=$allow_actual_tree remedy=\"--allow-outside $allow_path --scope slot=$allow_slot$allow_interval_remedy --scope to-tree=$allow_actual_tree --reason <text>\""
            allow_invalid=yes
          elif [ "$allow_to_tree" != "$allow_actual_tree" ]; then
            violate "check=declaration type=allow-outside subject=$allow_path scope=$allow_scope error=tree-mismatch expected=$allow_to_tree actual=$allow_actual_tree"
            allow_invalid=yes
          fi
        fi
    fi
    if [ "$allow_invalid" = no ] && [ "${allow_outside_consumed[$allow_index]}" != yes ]; then
      violate "check=declaration type=allow-outside subject=$allow_path scope=$allow_scope error=declared-but-unused"
    fi
    allow_index=$((allow_index + 1))
  done
}

path_matches_globs() {
  matched_candidate=$1
  shift
  for matched_glob in "$@"; do
    case "$matched_candidate" in $matched_glob) return 0 ;; esac
  done
  return 1
}

provenance_value() {
  provenance_key=$1
  provenance_path=$2
  awk -F= -v wanted="$provenance_key" \
    '$1 == wanted { sub(/^[^=]*=/, ""); print; exit }' "$provenance_path"
}

verify_provenance() {
  provenance_file="$CYCLE_DIR/harness.provenance"
  if [ ! -f "$provenance_file" ]; then
    violate "check=provenance error=missing-file"
    return
  fi
  provenance_source=$(provenance_value source "$provenance_file")
  provenance_head=$(provenance_value head "$provenance_file")
  provenance_expected=$(provenance_value rgr-sha "$provenance_file")
  provenance_copy_actual=$(git hash-object "$script_dir/rgr.sh" 2>/dev/null || true)
  [ -n "$provenance_expected" ] && [ "$provenance_expected" = "$provenance_copy_actual" ] \
    || violate "check=provenance field=rgr-sha expected=${provenance_expected:-missing} actual=${provenance_copy_actual:-missing}"
  if [ -z "$provenance_source" ] || [ ! -f "$provenance_source/harness/rgr.sh" ]; then
    violate "check=provenance field=source expected=readable-skill-root actual=${provenance_source:-missing}"
    return
  fi
  provenance_source_actual=$(git -C "$provenance_source" hash-object \
    "$provenance_source/harness/rgr.sh" 2>/dev/null || true)
  [ "$provenance_expected" = "$provenance_source_actual" ] \
    || violate "check=provenance field=source-rgr-sha expected=${provenance_expected:-missing} actual=${provenance_source_actual:-missing}"
  provenance_head_actual=$(git -C "$provenance_source" rev-parse HEAD 2>/dev/null || true)
  [ -n "$provenance_head" ] && [ "$provenance_head" = "$provenance_head_actual" ] \
    || violate "check=provenance field=head expected=${provenance_head:-missing} actual=${provenance_head_actual:-missing}"
}

verify_phase_order() {
  order_cycle=''
  order_expected=CYCLE
  while IFS= read -r order_line; do
    order_record=$(rgr_log_plain_field "$order_line" record 2>/dev/null || true)
    case "$order_record" in
      HEADER|BASELINE) continue ;;
      CYCLE)
        [ "$order_expected" = CYCLE ] \
          || violate "check=a cycle=${order_cycle:-unknown} error=incomplete-or-out-of-order expected=$order_expected actual=CYCLE"
        order_cycle=$(rgr_log_plain_field "$order_line" cycle 2>/dev/null || true)
        order_expected=RED
        ;;
      RED)
        [ "$order_expected" = RED ] \
          || violate "check=a cycle=${order_cycle:-unknown} error=incomplete-or-out-of-order expected=$order_expected actual=RED"
        order_expected=GREEN
        ;;
      GREEN)
        [ "$order_expected" = GREEN ] \
          || violate "check=a cycle=${order_cycle:-unknown} error=incomplete-or-out-of-order expected=$order_expected actual=GREEN"
        order_expected=CATCHES_OR_REFACTOR
        ;;
      CATCHES)
        [ "$order_expected" = CATCHES_OR_REFACTOR ] \
          || violate "check=a cycle=${order_cycle:-unknown} error=incomplete-or-out-of-order expected=$order_expected actual=CATCHES"
        order_expected=REFACTOR
        ;;
      REFACTOR)
        case "$order_expected" in
          CATCHES_OR_REFACTOR|REFACTOR) ;;
          *) violate "check=a cycle=${order_cycle:-unknown} error=incomplete-or-out-of-order expected=$order_expected actual=REFACTOR" ;;
        esac
        order_expected=CYCLE
        ;;
    esac
  done < "$log_file"
  [ "$order_expected" = CYCLE ] \
    || violate "check=a cycle=${order_cycle:-unknown} error=incomplete-or-out-of-order expected=$order_expected actual=EOF"
}

verify_phase_hashes() {
  phase_hash_first=''
  phase_hash_warned=no
  phase_hash_cycle=''
  while IFS= read -r phase_hash_line; do
    phase_hash_record=$(rgr_log_plain_field "$phase_hash_line" record 2>/dev/null || true)
    if [ "$phase_hash_record" = CYCLE ]; then
      phase_hash_cycle=$(rgr_log_plain_field "$phase_hash_line" cycle 2>/dev/null || true)
      continue
    fi
    case "$phase_hash_record" in RED|GREEN|CATCHES|REFACTOR) ;; *) continue ;; esac
    phase_hash_value=$(rgr_log_plain_field "$phase_hash_line" hash 2>/dev/null || true)
    case "$phase_hash_value" in ???????) ;; *) violate "check=provenance cycle=$phase_hash_cycle error=invalid-phase-hash value=${phase_hash_value:-missing}" ;; esac
    if [ -z "$phase_hash_first" ]; then
      phase_hash_first=$phase_hash_value
    elif [ "$phase_hash_value" != "$phase_hash_first" ] && [ "$phase_hash_warned" = no ]; then
      warn "warning harness-hash-changed first=$phase_hash_first later=$phase_hash_value cycle=$phase_hash_cycle"
      phase_hash_warned=yes
    fi
  done < "$log_file"
}

build_current_tree() {
  current_repo=$1
  current_env=$2
  current_index=$(mktemp "$CYCLE_DIR/.verify-rgr-index.XXXXXX") \
    || die "cannot create verification index"
  GIT_INDEX_FILE="$current_index" git -C "$current_repo" read-tree HEAD >/dev/null 2>&1 \
    || { rm -f "$current_index"; return 1; }
  set -- .
  current_excludes=$(env_value "$current_env" SNAPSHOT_EXCLUDE)
  for current_exclude in $current_excludes; do
    set -- "$@" ":(exclude)$current_exclude"
  done
  GIT_INDEX_FILE="$current_index" git -C "$current_repo" -c core.excludesFile=/dev/null add -A -- "$@" >/dev/null 2>&1 \
    || { rm -f "$current_index"; return 1; }
  current_tree=$(GIT_INDEX_FILE="$current_index" git -C "$current_repo" write-tree 2>/dev/null)
  current_status=$?
  rm -f "$current_index"
  [ "$current_status" -eq 0 ] || return "$current_status"
  printf '%s\n' "$current_tree"
}

verify_clean_production_interval() {
  scope_repo=$1
  scope_env=$2
  scope_slot=$3
  scope_label=$4
  scope_from=$5
  scope_to=$6
  register_outside_scope "$scope_slot" "$scope_label" "$scope_to"
  scope_test_globs=$(env_value "$scope_env" TEST_GLOBS)
  scope_doc_globs=$(env_value "$scope_env" DOC_GLOBS)
  scope_ignore_globs=$(env_value "$scope_env" IGNORE_GLOBS)
  scope_changes=$(git -C "$scope_repo" diff-tree -r --name-only "$scope_from" "$scope_to" 2>/dev/null)
  while IFS= read -r scope_path; do
    [ -n "$scope_path" ] || continue
    if path_matches_globs "$scope_path" $scope_test_globs \
      || path_matches_globs "$scope_path" $scope_doc_globs \
      || path_matches_globs "$scope_path" $scope_ignore_globs \
      || path_is_allowed_outside "$scope_path" "$scope_label" "$scope_slot" "$scope_to"; then
      continue
    fi
    violate "check=g slot=$scope_slot interval=$scope_label file=$scope_path"
  done <<EOF
$scope_changes
EOF
}

verify_current_production_scope() {
  current_scope_repo=$1
  current_scope_env=$2
  current_scope_slot=$3
  current_scope_label=$4
  current_scope_from=$5
  if ! current_scope_tree=$(build_current_tree "$current_scope_repo" "$current_scope_env"); then
    violate "check=g slot=$current_scope_slot error=cannot-snapshot-current-worktree"
    return
  fi
  verify_clean_production_interval "$current_scope_repo" "$current_scope_env" \
    "$current_scope_slot" "$current_scope_label" "$current_scope_from" "$current_scope_tree"
}

verify_outside_cycle_scope() {
  while IFS='=' read -r scope_slot scope_repo; do
    [ -n "$scope_slot" ] && [ -d "$scope_repo" ] || continue
    scope_current_env="$CYCLE_DIR/harness.$scope_slot.env"
    [ -f "$scope_current_env" ] \
      || { violate "check=g slot=$scope_slot error=missing-slot-env"; continue; }
    scope_previous=''
    scope_seen=0
    scope_last_cycle=''
    scope_last_header=''
    for scope_cycle in $cycle_numbers; do
      scope_header=$(rgr_log_cycle_header "$log_file" "$scope_cycle" 2>/dev/null || true)
      [ "$(rgr_log_plain_field "$scope_header" repo 2>/dev/null || true)" = "$scope_slot" ] || continue
      scope_env=$(materialize_cycle_env "$scope_repo" "$scope_cycle" "$scope_header" "$scope_current_env")
      if [ "$scope_seen" -eq 0 ]; then
        scope_previous=$(env_value "$scope_env" BASELINE_REF)
        git -C "$scope_repo" cat-file -e "$scope_previous^{commit}" 2>/dev/null \
          || { violate "check=g slot=$scope_slot error=invalid-baseline-ref value=${scope_previous:-missing}"; [ "$scope_env" = "$scope_current_env" ] || rm -f "$scope_env"; break; }
      fi
      scope_red=$(rgr_log_phase_line "$log_file" "$scope_cycle" RED 2>/dev/null || true)
      scope_refactor=$(rgr_log_phase_line "$log_file" "$scope_cycle" REFACTOR 2>/dev/null || true)
      scope_red_tree=$(rgr_log_plain_field "$scope_red" tree 2>/dev/null || true)
      scope_refactor_tree=$(rgr_log_plain_field "$scope_refactor" tree 2>/dev/null || true)
      if [ "$scope_seen" -eq 0 ]; then scope_interval=baseline-to-red-$scope_cycle; else scope_interval=refactor-to-red-$scope_cycle; fi
      verify_clean_production_interval "$scope_repo" "$scope_env" "$scope_slot" "$scope_interval" "$scope_previous" "$scope_red_tree"
      scope_previous=$scope_refactor_tree
      scope_seen=$((scope_seen + 1))
      scope_last_cycle=$scope_cycle
      scope_last_header=$scope_header
      [ "$scope_env" = "$scope_current_env" ] || rm -f "$scope_env"
    done
    if [ "$scope_seen" -gt 0 ]; then
      scope_env=$(materialize_cycle_env "$scope_repo" "$scope_last_cycle" "$scope_last_header" "$scope_current_env")
      verify_current_production_scope "$scope_repo" "$scope_env" "$scope_slot" \
        refactor-to-current "$scope_previous"
      [ "$scope_env" = "$scope_current_env" ] || rm -f "$scope_env"
    else
      scope_baseline=$(env_value "$scope_current_env" BASELINE_REF)
      if ! git -C "$scope_repo" cat-file -e "$scope_baseline^{commit}" 2>/dev/null; then
        violate "check=g slot=$scope_slot error=invalid-baseline-ref value=${scope_baseline:-missing}"
        continue
      fi
      verify_current_production_scope "$scope_repo" "$scope_current_env" "$scope_slot" \
        baseline-to-current "$scope_baseline"
    fi
  done < "$worktrees_file"
}

verify_ref() {
  verify_repo=$1
  verify_refname=$2
  verify_expected=$3
  verify_type=$4
  verify_label=$5
  if [ -z "$verify_expected" ]; then
    violate "check=b cycle=$verify_label error=missing-object-id"
    return
  fi
  git -C "$verify_repo" cat-file -e "$verify_expected^{$verify_type}" 2>/dev/null \
    || { violate "check=b cycle=$verify_label object=$verify_expected type=$verify_type"; return; }
  verify_actual=$(git -C "$verify_repo" rev-parse "$verify_refname" 2>/dev/null) \
    || { violate "check=b-prime cycle=$verify_label ref=$verify_refname missing=yes"; return; }
  [ "$verify_actual" = "$verify_expected" ] \
    || violate "check=b-prime cycle=$verify_label ref=$verify_refname expected=$verify_expected actual=$verify_actual"
}

junit_blob_total() {
  totals_repo=$1
  totals_blob=$2
  totals_key=$3
  git -C "$totals_repo" cat-file blob "$totals_blob" 2>/dev/null | awk -v key="$totals_key" '
    $1 == "<!--" && $2 == key { value = $3 }
    END { if (value != "") print value }
  '
}

junit_expected_exit() {
  if [ "$1" -gt 0 ]; then printf '1'; else printf '0'; fi
}

env_value() {
  awk -F= -v wanted="$2" '$1 == wanted { sub(/^[^=]*=/, ""); print; exit }' "$1"
}

materialize_cycle_env() {
  cycle_env_repo=$1
  cycle_env_cycle=$2
  cycle_env_header=$3
  cycle_env_fallback=$4
  cycle_env_sha=$(rgr_log_plain_field "$cycle_env_header" env 2>/dev/null || true)
  if [ "$cycle_env_sha" = unverifiable ]; then
    printf '%s\n' "$cycle_env_fallback"
    return
  fi
  case "$cycle_env_sha" in
    ''|*[!0-9a-f]*)
      violate "check=env cycle=$cycle_env_cycle error=invalid-or-missing-env value=${cycle_env_sha:-missing}"
      printf '%s\n' "$cycle_env_fallback"
      return
      ;;
  esac
  if [ "${#cycle_env_sha}" -ne 40 ]; then
    violate "check=env cycle=$cycle_env_cycle error=invalid-env-sha value=$cycle_env_sha"
    printf '%s\n' "$cycle_env_fallback"
    return
  fi
  cycle_env_tmp=$(mktemp "$CYCLE_DIR/.verify-rgr-env.XXXXXX") \
    || die "cannot create anchored env scratch file"
  if ! git -C "$cycle_env_repo" cat-file blob "$cycle_env_sha" > "$cycle_env_tmp" 2>/dev/null; then
    rm -f "$cycle_env_tmp"
    violate "check=env cycle=$cycle_env_cycle error=missing-env-blob sha=$cycle_env_sha"
    printf '%s\n' "$cycle_env_fallback"
    return
  fi
  printf '%s\n' "$cycle_env_tmp"
}

tap_blob_total() {
  git -C "$1" cat-file blob "$2" 2>/dev/null | awk -v key="$3" '
    $1 == "#" && $2 == key { value = $3 }
    END { if (value != "") print value }
  '
}

tap_blob_first_failure() {
  git -C "$1" cat-file blob "$2" 2>/dev/null | awk '/^not ok [0-9]+ - / { print; exit }'
}

tap_record_query() {
  tap_query_mode=$1
  tap_query_wanted=$2
  tap_query_file=$3
  RGR_TAP_QUERY_MODE=$tap_query_mode RGR_TAP_WANTED=$tap_query_wanted awk '
    BEGIN {
      mode = ENVIRON["RGR_TAP_QUERY_MODE"]
      wanted = ENVIRON["RGR_TAP_WANTED"]
    }
    /^(not )?ok [0-9]+ - / {
      status = ($0 ~ /^not ok /) ? "not-ok" : "ok"
      payload = $0
      sub(/^(not )?ok [0-9]+ - /, "", payload)
      name = ""
      directive = "none"
      escaped = 0
      for (i = 1; i <= length(payload); i++) {
        char = substr(payload, i, 1)
        if (escaped) { name = name char; escaped = 0 }
        else if (char == "\\") escaped = 1
        else if (char == "#") {
          marker = substr(payload, i + 1)
          if (marker ~ /^[[:space:]]*SKIP/) directive = "SKIP"
          else if (marker ~ /^[[:space:]]*TODO/) directive = "TODO"
          break
        } else name = name char
      }
      sub(/[[:space:]]+$/, "", name)
      if (mode == "first-failure-name" && status == "not-ok") {
        print name
        exit
      }
      if (mode == "selected-failure-name" && status == "not-ok" && name == wanted) {
        print name
      }
      if (mode == "directive" && status == "ok" && name == wanted) {
        print directive
        exit
      }
    }
  ' "$tap_query_file"
}

tap_blob_first_failure_name() {
  git -C "$1" cat-file blob "$2" 2>/dev/null | tap_record_query first-failure-name '' -
}

tap_blob_selected_failure_name() {
  git -C "$1" cat-file blob "$2" 2>/dev/null \
    | tap_record_query selected-failure-name "$3" -
}

tap_blob_is_file_failure() {
  tap_failure_repo=$1
  tap_failure_blob=$2
  tap_failure_file=$3
  tap_failure_base=$(basename "$tap_failure_file")
  git -C "$tap_failure_repo" cat-file blob "$tap_failure_blob" 2>/dev/null | awk \
    -v file="$tap_failure_file" -v base="$tap_failure_base" '
      /^not ok [0-9]+ - / {
        name = $0
        sub(/^not ok [0-9]+ - /, "", name)
        if (name == file || name == base) found = 1
      }
      END { exit(found ? 0 : 1) }
    '
}

verify_scalar() {
  scalar_cycle=$1
  scalar_line=$2
  scalar_field=$3
  scalar_expected=$4
  scalar_actual=$(rgr_log_plain_field "$scalar_line" "$scalar_field" 2>/dev/null || true)
  [ "$scalar_actual" = "$scalar_expected" ] \
    || violate "check=b-double-prime cycle=$scalar_cycle field=$scalar_field expected=$scalar_expected actual=${scalar_actual:-missing}"
}

suite_scalar_field() {
  suite_scalar_line=$1
  suite_scalar_primary=$2
  suite_scalar_legacy=$3
  suite_scalar_value=$(rgr_log_plain_field "$suite_scalar_line" "$suite_scalar_primary" 2>/dev/null || true)
  [ -n "$suite_scalar_value" ] \
    || suite_scalar_value=$(rgr_log_plain_field "$suite_scalar_line" "$suite_scalar_legacy" 2>/dev/null || true)
  printf '%s\n' "$suite_scalar_value"
}

verify_targeted_scalars() {
  targeted_repo=$1
  targeted_cycle=$2
  targeted_phase=$3
  targeted_line=$4
  targeted_env=$5
  targeted_blob=$(rgr_log_plain_field "$targeted_line" run-targeted 2>/dev/null || true)
  [ -n "$targeted_blob" ] || return

  targeted_tests=$(tap_blob_total "$targeted_repo" "$targeted_blob" tests)
  targeted_pass=$(tap_blob_total "$targeted_repo" "$targeted_blob" pass)
  targeted_fail=$(tap_blob_total "$targeted_repo" "$targeted_blob" fail)
  targeted_skipped=$(tap_blob_total "$targeted_repo" "$targeted_blob" skipped)
  targeted_todo=$(tap_blob_total "$targeted_repo" "$targeted_blob" todo)
  targeted_tests=${targeted_tests:-0}
  targeted_pass=${targeted_pass:-0}
  targeted_fail=${targeted_fail:-0}
  targeted_skipped=${targeted_skipped:-0}
  targeted_todo=${targeted_todo:-0}

  if [ "$targeted_phase" = red ]; then
    verify_scalar "$targeted_cycle/red" "$targeted_line" tests "$targeted_tests"
    verify_scalar "$targeted_cycle/red" "$targeted_line" pass "$targeted_pass"
    verify_scalar "$targeted_cycle/red" "$targeted_line" fail "$targeted_fail"
    verify_scalar "$targeted_cycle/red" "$targeted_line" skipped "$targeted_skipped"
    verify_scalar "$targeted_cycle/red" "$targeted_line" todo "$targeted_todo"
    verify_scalar "$targeted_cycle/red" "$targeted_line" directive none
    verify_scalar "$targeted_cycle/red" "$targeted_line" first \
      "$(tap_blob_first_failure "$targeted_repo" "$targeted_blob")"
    verify_scalar "$targeted_cycle/red" "$targeted_line" cmd \
      "$(env_value "$targeted_env" TEST_ONE_CMD)"
    targeted_test_file=$(rgr_log_quoted_field "$targeted_line" test-file 2>/dev/null || true)
    if [ "$targeted_tests" -eq 0 ] || tap_blob_is_file_failure "$targeted_repo" "$targeted_blob" "$targeted_test_file"; then
      targeted_class=broken
    else
      targeted_class=assertion
    fi
    verify_scalar "$targeted_cycle/red" "$targeted_line" class "$targeted_class"
    verify_scalar "$targeted_cycle/red" "$targeted_line" exit 1
    if [ "$targeted_class" = broken ]; then
      targeted_allow=$(rgr_log_quoted_field "$targeted_line" allow-import-red 2>/dev/null || true)
      [ -n "$targeted_allow" ] \
        || violate "check=c cycle=$targeted_cycle/red error=broken-red-without-allowance"
    fi
    targeted_name=$(rgr_log_quoted_field "$targeted_line" name 2>/dev/null || true)
    targeted_first=$(tap_blob_first_failure_name "$targeted_repo" "$targeted_blob")
    if [ "$targeted_class" = assertion ]; then
      [ "$targeted_first" = "$targeted_name" ] \
        || violate "check=c cycle=$targeted_cycle/red error=selected-name-not-failing name=$targeted_name"
    fi
  else
    verify_scalar "$targeted_cycle/green" "$targeted_line" target-exit 0
    verify_scalar "$targeted_cycle/green" "$targeted_line" target-tests "$targeted_tests"
    verify_scalar "$targeted_cycle/green" "$targeted_line" target-pass "$targeted_pass"
    verify_scalar "$targeted_cycle/green" "$targeted_line" target-fail "$targeted_fail"
    verify_scalar "$targeted_cycle/green" "$targeted_line" skipped "$targeted_skipped"
    verify_scalar "$targeted_cycle/green" "$targeted_line" todo "$targeted_todo"
    verify_scalar "$targeted_cycle/green" "$targeted_line" name-ok yes
    [ "$targeted_tests" -gt 0 ] && [ "$targeted_pass" -ge 1 ] \
      && [ "$targeted_fail" -eq 0 ] && [ "$targeted_skipped" -eq 0 ] && [ "$targeted_todo" -eq 0 ] \
      || violate "check=d cycle=$targeted_cycle/green error=targeted-run-not-green"
  fi
}

suite_status_blob_value() {
  status_repo=$1
  status_blob=$2
  git -C "$status_repo" cat-file blob "$status_blob" 2>/dev/null | awk '
    NR == 1 && /^[0-9]+$/ { value = $0; next }
    { invalid = 1 }
    END {
      if (NR == 1 && !invalid && value >= 0 && value <= 255) print value
    }
  '
}

verify_suite_scalars() {
  scalars_repo=$1
  scalars_cycle=$2
  scalars_phase=$3
  scalars_line=$4
  scalars_tests=0
  scalars_pass=0
  scalars_fail=0
  scalars_runs=0
  scalars_exit_frontier=$(rgr_log_plain_field "$scalars_line" suite-exits 2>/dev/null || true)
  if [ "$scalars_exit_frontier" = unverifiable ]; then
    record_unverified_cycle suite-exits "$scalars_cycle"
  fi
  for scalars_field in $(rgr_log_indexed_fields "$scalars_line" run-suite-); do
    scalars_key=${scalars_field%%=*}
    scalars_index=${scalars_key#run-suite-}
    scalars_blob=${scalars_field#*=}
    blob_tests=$(junit_blob_total "$scalars_repo" "$scalars_blob" tests)
    blob_pass=$(junit_blob_total "$scalars_repo" "$scalars_blob" pass)
    blob_fail=$(junit_blob_total "$scalars_repo" "$scalars_blob" fail)
    [ -n "$blob_tests" ] && [ -n "$blob_pass" ] && [ -n "$blob_fail" ] || {
      violate "check=b-double-prime cycle=$scalars_cycle/$scalars_phase error=unparseable-suite-run blob=$scalars_blob"
      continue
    }
    scalars_tests=$((scalars_tests + blob_tests))
    scalars_pass=$((scalars_pass + blob_pass))
    scalars_fail=$((scalars_fail + blob_fail))
    scalars_runs=$((scalars_runs + 1))
    expected_suite_exit=$(junit_expected_exit "$blob_fail")
    status_key="status-suite-$scalars_index"
    status_blob=$(rgr_log_plain_field "$scalars_line" "$status_key" 2>/dev/null || true)
    if [ -z "$status_blob" ]; then
      record_unverified_cycle suite-status "$scalars_cycle"
      if [ "$scalars_exit_frontier" != unverifiable ]; then
        verify_scalar "$scalars_cycle/$scalars_phase" "$scalars_line" \
          "suite-exit-$scalars_index" "$expected_suite_exit"
      fi
    else
      verify_ref "$scalars_repo" \
        "refs/rgr/$cycle_id/$scalars_cycle/$scalars_phase-status/suite-$scalars_index" \
        "$status_blob" blob "$scalars_cycle/$scalars_phase-$status_key"
      actual_suite_exit=$(suite_status_blob_value "$scalars_repo" "$status_blob")
      if [ -z "$actual_suite_exit" ]; then
        violate "check=b-double-prime cycle=$scalars_cycle/$scalars_phase field=$status_key error=invalid-status-blob"
      else
        verify_scalar "$scalars_cycle/$scalars_phase" "$scalars_line" \
          "suite-exit-$scalars_index" "$actual_suite_exit"
        [ "$actual_suite_exit" = "$expected_suite_exit" ] \
          || violate "check=b-double-prime cycle=$scalars_cycle/$scalars_phase field=$status_key expected=$expected_suite_exit actual=$actual_suite_exit"
      fi
    fi
  done
  logged_tests=$(suite_scalar_field "$scalars_line" suite-tests tests)
  logged_fail=$(suite_scalar_field "$scalars_line" suite-fail fail)
  [ "$logged_tests" = "$scalars_tests" ] \
    || violate "check=b-double-prime cycle=$scalars_cycle/$scalars_phase field=suite-tests expected=$scalars_tests actual=${logged_tests:-missing}"
  [ "$logged_fail" = "$scalars_fail" ] \
    || violate "check=b-double-prime cycle=$scalars_cycle/$scalars_phase field=suite-fail expected=$scalars_fail actual=${logged_fail:-missing}"
  if [ "$scalars_phase" = refactor ]; then
    verify_scalar "$scalars_cycle/refactor" "$scalars_line" pass "$scalars_pass"
    verify_scalar "$scalars_cycle/refactor" "$scalars_line" exit 0
  fi
}

verify_test_tree_invariant() {
  invariant_repo=$1
  invariant_cycle=$2
  invariant_label=$3
  invariant_from=$4
  invariant_to=$5
  invariant_line=$6
  invariant_env=$7
  invariant_globs=$(env_value "$invariant_env" TEST_GLOBS)
  invariant_changes=$(git -C "$invariant_repo" diff-tree -r --name-only \
    "$invariant_from" "$invariant_to" -- $invariant_globs 2>/dev/null)
  if [ -n "$invariant_changes" ]; then
    violate "check=e cycle=$invariant_cycle interval=$invariant_label files=$(printf '%s' "$invariant_changes" | tr '\n' ',')"
  fi
  verify_scalar "$invariant_cycle/$invariant_label" "$invariant_line" tests-diff EMPTY
}

verify_suite_universe() {
  universe_cycle=$1
  universe_green=$2
  universe_refactor=$3
  universe_env=$4
  universe_expected=$(env_value "$universe_env" TEST_CMD_N)
  universe_green_count=$(rgr_log_indexed_fields "$universe_green" run-suite- | wc -l | tr -d ' ')
  universe_refactor_count=$(rgr_log_indexed_fields "$universe_refactor" run-suite- | wc -l | tr -d ' ')
  [ "$universe_green_count" = "$universe_expected" ] \
    || violate "check=f cycle=$universe_cycle phase=green error=suite-count expected=$universe_expected actual=$universe_green_count"
  [ "$universe_refactor_count" = "$universe_expected" ] \
    || violate "check=f cycle=$universe_cycle phase=refactor error=suite-count expected=$universe_expected actual=$universe_refactor_count"
  [ "$universe_green_count" = "$universe_refactor_count" ] \
    || violate "check=f cycle=$universe_cycle error=suite-universe-changed green=$universe_green_count refactor=$universe_refactor_count"
  universe_index=1
  while [ "$universe_index" -le "$universe_expected" ]; do
    [ -n "$(rgr_log_plain_field "$universe_green" "run-suite-$universe_index" 2>/dev/null || true)" ] \
      || violate "check=f cycle=$universe_cycle phase=green error=missing-run-suite-$universe_index"
    [ -n "$(rgr_log_plain_field "$universe_refactor" "run-suite-$universe_index" 2>/dev/null || true)" ] \
      || violate "check=f cycle=$universe_cycle phase=refactor error=missing-run-suite-$universe_index"
    universe_index=$((universe_index + 1))
  done
  verify_scalar "$universe_cycle/refactor" "$universe_refactor" same yes
  green_suite_tests=$(suite_scalar_field "$universe_green" suite-tests tests)
  refactor_suite_tests=$(suite_scalar_field "$universe_refactor" suite-tests tests)
  [ "$refactor_suite_tests" = "$green_suite_tests" ] \
    || violate "check=f cycle=$universe_cycle/refactor field=suite-tests expected=$green_suite_tests actual=${refactor_suite_tests:-missing}"
}

derive_suite_failset() {
  failset_repo=$1
  failset_line=$2
  failset_output=$3
  failset_root=$4
  failset_unsorted=$(mktemp "$CYCLE_DIR/.verify-rgr-failset.XXXXXX") \
    || die "cannot create failure-set scratch file"
  : > "$failset_unsorted"
  for failset_field in $(rgr_log_indexed_fields "$failset_line" run-suite-); do
    failset_blob=${failset_field#*=}
    git -C "$failset_repo" cat-file blob "$failset_blob" 2>/dev/null | awk -v root="$failset_root/" '
      /<testcase / && / failure="/ {
        name = $0
        file = $0
        sub(/^.* name="/, "", name)
        sub(/".*$/, "", name)
        sub(/^.* file="/, "", file)
        sub(/".*$/, "", file)
        if (index(file, root) == 1) file = substr(file, length(root) + 1)
        print file "::" name
      }
    ' >> "$failset_unsorted"
  done
  LC_ALL=C sort -u "$failset_unsorted" > "$failset_output"
  rm -f "$failset_unsorted"
}

verify_derived_failset() {
  derived_repo=$1
  derived_cycle=$2
  derived_phase=$3
  derived_line=$4
  derived_root=$5
  derived_sha=$(rgr_log_plain_field "$derived_line" failset 2>/dev/null || true)
  derived_file=$(mktemp "$CYCLE_DIR/.verify-rgr-derived.XXXXXX") \
    || die "cannot create derived failure-set file"
  recorded_file=$(mktemp "$CYCLE_DIR/.verify-rgr-recorded.XXXXXX") \
    || die "cannot create recorded failure-set file"
  derive_suite_failset "$derived_repo" "$derived_line" "$derived_file" "$derived_root"
  git -C "$derived_repo" cat-file blob "$derived_sha" > "$recorded_file" 2>/dev/null || : > "$recorded_file"
  cmp -s "$derived_file" "$recorded_file" \
    || violate "check=b-double-prime cycle=$derived_cycle/$derived_phase field=failset error=not-derived-from-suite-runs"
  rm -f "$derived_file" "$recorded_file"
}

baseline_is_immutable_ref() {
  baseline_repo=$1
  baseline_sha=$2
  git -C "$baseline_repo" for-each-ref --format='%(refname) %(objectname)' \
    "refs/rgr/$cycle_id/baseline/" 2>/dev/null | awk -v wanted="$baseline_sha" '
      $1 ~ /\/baseline\/[0-9][0-9][0-9]$/ && $2 == wanted { found = 1 }
      END { exit(found ? 0 : 1) }
    '
}

verify_cycle_baseline() {
  binding_repo=$1
  binding_cycle=$2
  binding_green=$3
  binding_refactor=$4
  binding_green_sha=$(rgr_log_plain_field "$binding_green" baseline 2>/dev/null || true)
  binding_refactor_sha=$(rgr_log_plain_field "$binding_refactor" baseline 2>/dev/null || true)
  [ -n "$binding_green_sha" ] && baseline_is_immutable_ref "$binding_repo" "$binding_green_sha" \
    || violate "check=b-prime cycle=$binding_cycle/green field=baseline error=not-owned-by-immutable-ref sha=${binding_green_sha:-missing}"
  [ -n "$binding_refactor_sha" ] && baseline_is_immutable_ref "$binding_repo" "$binding_refactor_sha" \
    || violate "check=b-prime cycle=$binding_cycle/refactor field=baseline error=not-owned-by-immutable-ref sha=${binding_refactor_sha:-missing}"
  [ "$binding_green_sha" = "$binding_refactor_sha" ] \
    || violate "check=f cycle=$binding_cycle field=baseline error=changed-during-refactor"

  binding_baseline=$(mktemp "$CYCLE_DIR/.verify-rgr-baseline.XXXXXX") \
    || die "cannot create baseline scratch file"
  binding_green_set=$(mktemp "$CYCLE_DIR/.verify-rgr-green-set.XXXXXX") \
    || die "cannot create GREEN failure-set scratch file"
  git -C "$binding_repo" cat-file blob "$binding_green_sha" > "$binding_baseline" 2>/dev/null || : > "$binding_baseline"
  binding_green_failset=$(rgr_log_plain_field "$binding_green" failset 2>/dev/null || true)
  git -C "$binding_repo" cat-file blob "$binding_green_failset" > "$binding_green_set" 2>/dev/null || : > "$binding_green_set"
  binding_new=$(comm -13 "$binding_baseline" "$binding_green_set" | wc -l | tr -d ' ')
  verify_scalar "$binding_cycle/green" "$binding_green" new-fails "$binding_new"
  [ "$binding_new" -eq 0 ] \
    || violate "check=d cycle=$binding_cycle/green error=new-failures count=$binding_new"
  rm -f "$binding_baseline" "$binding_green_set"
}

verify_refactor_failset() {
  refset_repo=$1
  refset_cycle=$2
  refset_green=$3
  refset_refactor=$4
  refset_green_sha=$(rgr_log_plain_field "$refset_green" failset 2>/dev/null || true)
  refset_refactor_sha=$(rgr_log_plain_field "$refset_refactor" failset 2>/dev/null || true)
  [ "$refset_green_sha" = "$refset_refactor_sha" ] \
    || violate "check=f cycle=$refset_cycle field=failset error=changed-during-refactor"
  verify_scalar "$refset_cycle/refactor" "$refset_refactor" failset-diff EMPTY
}

catches_evidence_is_unverifiable() {
  catches_frontier_line=$1
  [ -n "$catches_frontier_line" ] || return 0
  catches_frontier_value=$(rgr_log_plain_field "$catches_frontier_line" catches 2>/dev/null || true)
  catches_frontier_run=$(rgr_log_plain_field "$catches_frontier_line" run-targeted 2>/dev/null || true)
  [ "$catches_frontier_value" = n/a ] || [ -z "$catches_frontier_run" ]
}

verify_catches() {
  catches_repo=$1
  catches_cycle=$2
  catches_red=$3
  catches_line=$4
  if [ -z "$catches_line" ]; then
    warn "warning cycle=$catches_cycle catches=missing not-mutation-verified=yes"
    return
  fi
  catches_value=$(rgr_log_plain_field "$catches_line" catches 2>/dev/null || true)
  catches_sha=$(rgr_log_plain_field "$catches_line" catches-failset 2>/dev/null || true)
  catches_run_sha=$(rgr_log_plain_field "$catches_line" run-targeted 2>/dev/null || true)
  verify_ref "$catches_repo" "refs/rgr/$cycle_id/$catches_cycle/catches-failset" \
    "$catches_sha" blob "$catches_cycle/catches-failset"
  if [ -z "$catches_run_sha" ]; then
    warn "warning cycle=$catches_cycle catches=unverifiable reason=legacy-no-targeted-run not-mutation-verified=yes"
    return
  fi
  verify_ref "$catches_repo" "refs/rgr/$cycle_id/$catches_cycle/catches-run/targeted" \
    "$catches_run_sha" blob "$catches_cycle/catches-run-targeted"
  catches_file=$(rgr_log_quoted_field "$catches_red" test-file 2>/dev/null || true)
  catches_name=$(rgr_log_quoted_field "$catches_red" name 2>/dev/null || true)
  catches_derived=$(mktemp "$CYCLE_DIR/.verify-rgr-catches.XXXXXX") \
    || die "cannot create catches failure-set scratch file"
  tap_blob_selected_failure_name "$catches_repo" "$catches_run_sha" "$catches_name" \
    | awk -v file="$catches_file" '{ print file "::" $0 }' \
    | LC_ALL=C sort -u > "$catches_derived"
  catches_recorded=$(mktemp "$CYCLE_DIR/.verify-rgr-catches-recorded.XXXXXX") \
    || die "cannot create catches recorded failure-set scratch file"
  git -C "$catches_repo" cat-file blob "$catches_sha" > "$catches_recorded" 2>/dev/null \
    || : > "$catches_recorded"
  cmp -s "$catches_derived" "$catches_recorded" \
    || violate "check=b-double-prime cycle=$catches_cycle/catches field=failset error=not-derived-from-targeted-run"
  case "$catches_value" in
    yes)
      git -C "$catches_repo" cat-file blob "$catches_sha" 2>/dev/null \
        | grep -F -x "$catches_file::$catches_name" >/dev/null \
        || violate "check=b-double-prime cycle=$catches_cycle/catches error=selected-test-absent"
      ;;
    no)
      [ "$(git -C "$catches_repo" cat-file -s "$catches_sha" 2>/dev/null || echo missing)" = 0 ] \
        || violate "check=b-double-prime cycle=$catches_cycle/catches error=no-with-nonempty-failset"
      warn "warning cycle=$catches_cycle catches=no mutation-not-caught=yes"
      ;;
    n/a)
      catches_reason=$(rgr_log_quoted_field "$catches_line" reason 2>/dev/null || true)
      [ "$catches_reason" = new-file ] \
        || violate "check=b-double-prime cycle=$catches_cycle/catches error=invalid-na-reason"
      warn "warning cycle=$catches_cycle catches=n/a not-mutation-verified=yes reason=${catches_reason:-missing}"
      ;;
    *) violate "check=b-double-prime cycle=$catches_cycle/catches error=invalid-value value=${catches_value:-missing}" ;;
  esac
  rm -f "$catches_derived" "$catches_recorded"
}

report_baseline_diff() {
  baseline_diff_repo=$1
  baseline_diff_previous_seq=$2
  baseline_diff_previous_sha=$3
  baseline_diff_current_seq=$4
  baseline_diff_current_sha=$5
  baseline_previous_set=$(mktemp "$CYCLE_DIR/.verify-rgr-baseline-previous.XXXXXX") \
    || die "cannot create previous baseline scratch file"
  baseline_current_set=$(mktemp "$CYCLE_DIR/.verify-rgr-baseline-current.XXXXXX") \
    || die "cannot create current baseline scratch file"
  git -C "$baseline_diff_repo" cat-file blob "$baseline_diff_previous_sha" > "$baseline_previous_set" 2>/dev/null \
    || : > "$baseline_previous_set"
  git -C "$baseline_diff_repo" cat-file blob "$baseline_diff_current_sha" > "$baseline_current_set" 2>/dev/null \
    || : > "$baseline_current_set"
  baseline_added=$(comm -13 "$baseline_previous_set" "$baseline_current_set")
  baseline_removed=$(comm -23 "$baseline_previous_set" "$baseline_current_set")
  baseline_added_count=$(printf '%s\n' "$baseline_added" | awk 'NF { count++ } END { print count + 0 }')
  baseline_removed_count=$(printf '%s\n' "$baseline_removed" | awk 'NF { count++ } END { print count + 0 }')
  warn "warning baseline-recaptured from=$baseline_diff_previous_seq to=$baseline_diff_current_seq added=$baseline_added_count removed=$baseline_removed_count"
  if [ -n "$baseline_added" ]; then
    while IFS= read -r baseline_value; do
      warn "baseline-added seq=$baseline_diff_current_seq value=\"$(rgr_log_escape "$baseline_value")\""
    done <<EOF
$baseline_added
EOF
  fi
  if [ -n "$baseline_removed" ]; then
    while IFS= read -r baseline_value; do
      warn "baseline-removed seq=$baseline_diff_current_seq value=\"$(rgr_log_escape "$baseline_value")\""
    done <<EOF
$baseline_removed
EOF
  fi
  rm -f "$baseline_previous_set" "$baseline_current_set"
}

verify_baseline_records() {
  baseline_records=$(rgr_log_records "$log_file" BASELINE) || {
    violate "check=a error=invalid-baseline-record"
    return
  }
  if [ -z "$baseline_records" ]; then
    violate "check=a error=no-baseline-records"
    return
  fi
  baseline_count=0
  baseline_history=$(mktemp "$CYCLE_DIR/.verify-rgr-baseline-history.XXXXXX") \
    || die "cannot create baseline history scratch file"
  : > "$baseline_history"
  while IFS= read -r baseline_record; do
    baseline_count=$((baseline_count + 1))
    baseline_record_slot=$(rgr_log_plain_field "$baseline_record" slot 2>/dev/null || true)
    baseline_record_repo=$(repo_for_slot "$baseline_record_slot")
    baseline_record_seq=$(rgr_log_plain_field "$baseline_record" seq 2>/dev/null || true)
    baseline_record_sha=$(rgr_log_plain_field "$baseline_record" failset 2>/dev/null || true)
    baseline_record_fails=$(rgr_log_plain_field "$baseline_record" fails 2>/dev/null || true)
    if [ -z "$baseline_record_repo" ]; then
      violate "check=a baseline=$baseline_count error=unknown-slot slot=$baseline_record_slot"
      continue
    fi
    verify_ref "$baseline_record_repo" "refs/rgr/$cycle_id/baseline/$baseline_record_seq" \
      "$baseline_record_sha" blob "baseline/$baseline_record_seq"
    baseline_actual_fails=$(git -C "$baseline_record_repo" cat-file blob "$baseline_record_sha" 2>/dev/null \
      | awk 'NF { count++ } END { print count + 0 }')
    [ "$baseline_record_fails" = "$baseline_actual_fails" ] \
      || violate "check=b-double-prime baseline=$baseline_record_seq field=fails expected=$baseline_actual_fails actual=${baseline_record_fails:-missing}"
    baseline_previous=$(awk -v slot="$baseline_record_slot" '$1 == slot { line = $0 } END { print line }' "$baseline_history")
    if [ -n "$baseline_previous" ]; then
      baseline_previous_seq=$(printf '%s\n' "$baseline_previous" | awk '{ print $2 }')
      baseline_previous_sha=$(printf '%s\n' "$baseline_previous" | awk '{ print $3 }')
      report_baseline_diff "$baseline_record_repo" "$baseline_previous_seq" "$baseline_previous_sha" \
        "$baseline_record_seq" "$baseline_record_sha"
    fi
    printf '%s %s %s\n' "$baseline_record_slot" "$baseline_record_seq" "$baseline_record_sha" >> "$baseline_history"
  done <<EOF
$baseline_records
EOF
  rm -f "$baseline_history"
}

tap_directive_for_name() {
  directive_name=$1
  directive_file=$2
  tap_record_query directive "$directive_name" "$directive_file"
}

verify_green_directive() {
  directive_repo=$1
  directive_cycle=$2
  directive_red_line=$3
  directive_green_line=$4
  directive_name=$(rgr_log_quoted_field "$directive_red_line" name) || {
    violate "check=a cycle=$directive_cycle/red error=invalid-name-field"
    return
  }
  directive_blob=$(rgr_log_plain_field "$directive_green_line" run-targeted)
  directive_output=$(mktemp "$CYCLE_DIR/.verify-rgr-targeted.XXXXXX") \
    || die "cannot create targeted-run scratch file"
  git -C "$directive_repo" cat-file blob "$directive_blob" > "$directive_output" 2>/dev/null || {
    rm -f "$directive_output"
    return
  }
  expected_directive=$(tap_directive_for_name "$directive_name" "$directive_output")
  rm -f "$directive_output"
  logged_directive=$(rgr_log_plain_field "$directive_green_line" directive)
  [ -n "$expected_directive" ] || expected_directive=missing
  [ "$logged_directive" = "$expected_directive" ] \
    || violate "check=b-double-prime cycle=$directive_cycle/green field=directive expected=$expected_directive actual=${logged_directive:-missing}"
}

cycle_numbers=$(rgr_log_cycle_numbers "$log_file") || die "rgr.log contains an invalid line" 2
discover_first_anchored_evidence_cycles
validate_frontier_declarations
debt_index=0
while [ "$debt_index" -lt "${#debt_subjects[@]}" ]; do
  debt_cycle=${debt_cycles[$debt_index]}
  cycle_is_logged "$debt_cycle" \
    || violate "check=declaration type=debt subject=${debt_subjects[$debt_index]} scope=cycle=$debt_cycle error=unknown-cycle"
  debt_index=$((debt_index + 1))
done
verify_provenance
verify_phase_order
verify_phase_hashes
cycle_count=0
previous_cycle=0
expected_cycle=1
env_unverifiable_cycles=''
suite_exit_unverifiable_cycles=''
suite_status_unverifiable_cycles=''
catches_unverifiable_cycles=''
frontier_violation_dimensions=''
for cycle in $cycle_numbers; do
  cycle_count=$((cycle_count + 1))
  [ "$cycle" -gt "$previous_cycle" ] \
    || violate "check=a cycle=$cycle error=cycle-numbers-not-global-monotonic"
  [ "$cycle" -eq "$expected_cycle" ] \
    || violate "check=a cycle=$cycle error=cycle-numbers-not-contiguous expected=$expected_cycle"
  previous_cycle=$cycle
  expected_cycle=$((expected_cycle + 1))
  cycle_header=$(rgr_log_cycle_header "$log_file" "$cycle")
  slot=$(rgr_log_plain_field "$cycle_header" repo)
  repo=$(repo_for_slot "$slot")
  if [ -z "$repo" ] || [ ! -d "$repo" ]; then
    violate "check=a cycle=$cycle error=unknown-slot slot=$slot"
    continue
  fi
  red_line=$(rgr_log_phase_line "$log_file" "$cycle" RED 2>/dev/null || true)
  green_line=$(rgr_log_phase_line "$log_file" "$cycle" GREEN 2>/dev/null || true)
  catches_line=$(rgr_log_phase_line "$log_file" "$cycle" CATCHES 2>/dev/null || true)
  refactor_line=$(rgr_log_phase_line "$log_file" "$cycle" REFACTOR 2>/dev/null || true)
  [ -n "$red_line" ] && [ -n "$green_line" ] && [ -n "$refactor_line" ] \
    || { violate "check=a cycle=$cycle error=incomplete-or-out-of-order"; continue; }
  slot_env_file="$CYCLE_DIR/harness.$slot.env"
  [ -f "$slot_env_file" ] || { violate "check=a cycle=$cycle error=missing-slot-env slot=$slot"; continue; }
  cycle_env_sha=$(rgr_log_plain_field "$cycle_header" env 2>/dev/null || true)
  if [ "$cycle_env_sha" = unverifiable ]; then
    record_unverified_cycle env "$cycle"
  else
    verify_ref "$repo" "refs/rgr/$cycle_id/$cycle/env" "$cycle_env_sha" blob "$cycle/env"
  fi
  env_file=$(materialize_cycle_env "$repo" "$cycle" "$cycle_header" "$slot_env_file")

  verify_ref "$repo" "refs/rgr/$cycle_id/$cycle/red" "$(rgr_log_plain_field "$red_line" tree)" tree "$cycle/red"
  verify_ref "$repo" "refs/rgr/$cycle_id/$cycle/green" "$(rgr_log_plain_field "$green_line" tree)" tree "$cycle/green"
  verify_ref "$repo" "refs/rgr/$cycle_id/$cycle/refactor" "$(rgr_log_plain_field "$refactor_line" tree)" tree "$cycle/refactor"
  verify_ref "$repo" "refs/rgr/$cycle_id/$cycle/red-run/targeted" \
    "$(rgr_log_plain_field "$red_line" run-targeted)" blob "$cycle/red-run-targeted"
  verify_ref "$repo" "refs/rgr/$cycle_id/$cycle/green-run/targeted" \
    "$(rgr_log_plain_field "$green_line" run-targeted)" blob "$cycle/green-run-targeted"
  verify_targeted_scalars "$repo" "$cycle" red "$red_line" "$env_file"
  verify_targeted_scalars "$repo" "$cycle" green "$green_line" "$env_file"
  verify_green_directive "$repo" "$cycle" "$red_line" "$green_line"
  verify_ref "$repo" "refs/rgr/$cycle_id/$cycle/green-failset" \
    "$(rgr_log_plain_field "$green_line" failset)" blob "$cycle/green-failset"
  verify_ref "$repo" "refs/rgr/$cycle_id/$cycle/refactor-failset" \
    "$(rgr_log_plain_field "$refactor_line" failset)" blob "$cycle/refactor-failset"

  red_tree=$(rgr_log_plain_field "$red_line" tree)
  green_tree=$(rgr_log_plain_field "$green_line" tree)
  refactor_tree=$(rgr_log_plain_field "$refactor_line" tree)
  verify_test_tree_invariant "$repo" "$cycle" red-to-green "$red_tree" "$green_tree" "$green_line" "$env_file"
  verify_test_tree_invariant "$repo" "$cycle" green-to-refactor "$green_tree" "$refactor_tree" "$refactor_line" "$env_file"
  verify_suite_universe "$cycle" "$green_line" "$refactor_line" "$env_file"
  verify_derived_failset "$repo" "$cycle" green "$green_line" "$repo"
  verify_derived_failset "$repo" "$cycle" refactor "$refactor_line" "$repo"
  verify_cycle_baseline "$repo" "$cycle" "$green_line" "$refactor_line"
  verify_refactor_failset "$repo" "$cycle" "$green_line" "$refactor_line"
  if catches_evidence_is_unverifiable "$catches_line"; then
    record_unverified_cycle catches "$cycle"
  fi
  verify_catches "$repo" "$cycle" "$red_line" "$catches_line"

  for phase in green refactor; do
    if [ "$phase" = green ]; then run_line=$green_line; else run_line=$refactor_line; fi
    for run_field in $(rgr_log_indexed_fields "$run_line" run-suite-); do
      run_key=${run_field%%=*}
      run_index=${run_key#run-suite-}
      run_sha=${run_field#*=}
      verify_ref "$repo" "refs/rgr/$cycle_id/$cycle/$phase-run/suite-$run_index" \
        "$run_sha" blob "$cycle/$phase-$run_key"
    done
    verify_suite_scalars "$repo" "$cycle" "$phase" "$run_line"
  done
  [ "$env_file" = "$slot_env_file" ] || rm -f "$env_file"
done
[ "$cycle_count" -gt 0 ] || violate "check=a error=no-cycles"

while IFS='=' read -r ref_slot ref_repo; do
  [ -n "$ref_slot" ] && [ -d "$ref_repo" ] || continue
  for ref_cycle in $(git -C "$ref_repo" for-each-ref --format='%(refname)' "refs/rgr/$cycle_id/" 2>/dev/null \
    | sed "s#^refs/rgr/$cycle_id/##" | awk -F/ '$1 ~ /^[0-9]+$/ { print $1 }' | LC_ALL=C sort -nu); do
    cycle_is_logged "$ref_cycle" \
      || violate "check=a slot=$ref_slot cycle=$ref_cycle error=orphan-cycle-ref"
  done
done < "$worktrees_file"

verify_baseline_records
verify_outside_cycle_scope
validate_allow_outside_declarations
if [ -f "$CYCLE_DIR/plan.md" ]; then
  planned_cases=$(awk -F'|' '
    {
      value = $2
      gsub(/\*/, "", value)
      gsub(/[[:space:]]/, "", value)
      if (value ~ /^[0-9]+$/ && value + 0 > maximum + 0) maximum = value + 0
    }
    END { if (maximum != "") print maximum }
  ' "$CYCLE_DIR/plan.md")
  if [ -n "$planned_cases" ] && [ "$cycle_count" -lt "$planned_cases" ]; then
    warn "warning plan-coverage cycles=$cycle_count planned-cases=$planned_cases manual-review-required=yes"
  fi
fi
baseline_line=$(rgr_log_first_record "$log_file" BASELINE 2>/dev/null || true)
baseline_slot=$(rgr_log_plain_field "$baseline_line" slot)
baseline_fails=$(rgr_log_plain_field "$baseline_line" fails)
baseline_at=$(rgr_log_plain_field "$baseline_line" at)
violation_count=$(wc -l < "$violations_file" | tr -d ' ')
if [ "$violation_count" -eq 0 ]; then
  gate_result=PASS
  gate_exit=0
else
  gate_result=VIOLATION
  gate_exit=2
fi
{
  printf '%s\n' '## GATE' "RESULT: $gate_result" "exit=$gate_exit"
  printf '%s\n' \
    'covered=cycle-order,refs,targeted-scalars,test-tree-invariants,suite-universe,suite-scalars,failsets,baselines,catches,provenance,outside-cycle-scope' \
    'not-covered=semantic-assertion-quality,refactor-behavior-equivalence,plan-test-coverage'
  printf 'baseline slot=%s fails=%s at=%s\n' "$baseline_slot" "$baseline_fails" "$baseline_at"
  printf 'cycles=%s\n' "$cycle_count"
  printf '%s\n' 'UNVERIFIED'
  report_unverified_dimension env "$env_unverifiable_cycles"
  report_unverified_dimension suite-exits "$suite_exit_unverifiable_cycles"
  report_unverified_dimension suite-status "$suite_status_unverifiable_cycles"
  report_unverified_dimension catches "$catches_unverifiable_cycles"
  report_declared_exceptions
  cat "$violations_file"
  cat "$warnings_file"
} > "$report_file" || die "cannot write $report_file"
sed -n '1,30p' "$report_file"
exit "$gate_exit"
