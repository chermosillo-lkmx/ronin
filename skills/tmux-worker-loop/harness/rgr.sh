#!/usr/bin/env bash
# rgr.sh v1
#
# WHY THIS EXISTS
# Hand-written RGR logs let a broken test or a behavior-changing refactor look
# valid. This command runs each phase, anchors its tree, and writes the evidence.
#
# Usage: rgr.sh [--repo <slot>] <red|green|verify-catches|refactor|baseline|repair> [phase arguments]
# Env: CYCLE_DIR must name the cycle artifacts directory.

set -u

script_dir=$(cd "$(dirname "$0")" && pwd -P)
. "$script_dir/rgr-log.sh"

die() {
  echo "rgr: $1" >&2
  exit "${2:-1}"
}

require_evidence_id() {
  evidence_label=$1
  evidence_id=$2
  [ -n "$evidence_id" ] || die "$evidence_label evidence returned an empty object id"
}

validate_test_name() {
  local test_name_value test_name_index test_name_character test_name_label
  local LC_ALL=C
  test_name_value=$1
  test_name_index=0
  while [ "$test_name_index" -lt "${#test_name_value}" ]; do
    test_name_character=${test_name_value:$test_name_index:1}
    test_name_label=''
    case "$test_name_character" in
      $'\b') test_name_label='backspace (BS, U+0008)' ;;
      $'\t') test_name_label='horizontal tab (TAB, U+0009)' ;;
      $'\n') test_name_label='line feed (LF, U+000A)' ;;
      $'\v') test_name_label='vertical tab (VT, U+000B)' ;;
      $'\f') test_name_label='form feed (FF, U+000C)' ;;
      $'\r') test_name_label='carriage return (CR, U+000D)' ;;
      [[:cntrl:]])
        printf -v test_name_label 'control character (U+%04X)' "'$test_name_character"
        ;;
    esac
    if [ -n "$test_name_label" ]; then
      die "test name contains control character $test_name_label at position $((test_name_index + 1))"
    fi
    test_name_index=$((test_name_index + 1))
  done
}

if [ -z "${CYCLE_DIR:-}" ]; then
  die "CYCLE_DIR unset; export the cycle artifacts directory"
fi
if [ ! -d "$CYCLE_DIR" ]; then
  die "CYCLE_DIR does not exist: $CYCLE_DIR"
fi
CYCLE_DIR=$(cd "$CYCLE_DIR" && pwd -P) || die "cannot resolve CYCLE_DIR"

repo_override=''
if [ "${1:-}" = '--repo' ]; then
  [ "$#" -ge 3 ] || die "--repo requires a slot and a subcommand"
  repo_override=$2
  shift 2
fi
subcommand=${1:-}
[ -n "$subcommand" ] || die "usage: rgr.sh [--repo <slot>] <red|green|verify-catches|refactor|repair>"
shift

worktrees_file="$CYCLE_DIR/worktrees.env"
[ -f "$worktrees_file" ] || die "missing $worktrees_file; declare physical worktree paths first"

worktree=$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null) || worktree=''
slot=''
while IFS='=' read -r declared_slot declared_path; do
  [ -n "$declared_slot" ] || continue
  declared_physical_path=$(cd "$declared_path" 2>/dev/null && pwd -P) \
    || die "declared worktree path is not reachable for slot '$declared_slot': $declared_path"
  case "$CYCLE_DIR/" in
    "$declared_physical_path/"*) die "CYCLE_DIR is inside declared worktree '$declared_slot'; move cycle artifacts outside every worktree" ;;
  esac
  if [ "$declared_physical_path" = "$worktree" ]; then
    slot=$declared_slot
  fi
done < "$worktrees_file"

if [ -z "$slot" ]; then
  echo "rgr: cwd resolves outside declared worktrees: ${worktree:-$PWD}" >&2
  echo "rgr: declared worktrees:" >&2
  sed 's/^/  /' "$worktrees_file" >&2
  exit 4
fi
if [ -n "$repo_override" ] && [ "$repo_override" != "$slot" ]; then
  die "--repo '$repo_override' disagrees with cwd slot '$slot'"
fi

env_file="$CYCLE_DIR/harness.$slot.env"
[ -f "$env_file" ] || die "missing $env_file; run probe-repo.sh $slot first"
invalid_env=$(awk '!/^[A-Z_]+(_[0-9]+)?=/{print; exit 1}' "$env_file")
invalid_env_status=$?
[ "$invalid_env_status" -eq 0 ] || die "invalid harness env line '$invalid_env'; regenerate $env_file"

env_get() {
  awk -F= -v wanted="$1" '$1 == wanted { sub(/^[^=]*=/, ""); print; exit }' "$env_file"
}

stack=$(env_get STACK)
test_one_cmd=$(env_get TEST_ONE_CMD)
pass_format=$(env_get PASS_FORMAT)
failset_format=$(env_get FAILSET_FORMAT)
baseline_failset=$(env_get BASELINE_FAILSET)
snapshot_exclude=$(env_get SNAPSHOT_EXCLUDE)
[ -n "$snapshot_exclude" ] || die "SNAPSHOT_EXCLUDE is empty; regenerate $env_file with probe-repo.sh $slot"
deps_ok=$(env_get DEPS_OK)
[ "$deps_ok" = yes ] || die "DEPS_OK=no for slot '$slot'; provision dependencies before running RGR"
test_timeout=$(env_get TEST_TIMEOUT)
case "$test_timeout" in ''|*[!0-9]*|0) die "TEST_TIMEOUT must be a positive integer; rerun probe-repo.sh $slot" ;; esac

escape_regex() {
  printf '%s' "$1" | sed 's/[][(){}.*+?^$|\\]/\\&/g'
}

run_with_watchdog() {
  watchdog_output=$1
  shift
  watchdog_previous_dir=$PWD
  cd "$worktree" || die "cannot enter worktree $worktree"
  perl -e '
    $seconds = shift @ARGV;
    $pid = fork();
    exit 125 unless defined $pid;
    if ($pid == 0) { exec @ARGV; exit 127 }
    $SIG{ALRM} = sub { kill "TERM", $pid; waitpid($pid, 0); exit 124 };
    alarm $seconds;
    waitpid($pid, 0);
    alarm 0;
    $status = $?;
    exit(($status & 127) ? 128 + ($status & 127) : $status >> 8);
  ' "$test_timeout" "$@" > "$watchdog_output" 2>&1
  watchdog_status=$?
  cd "$watchdog_previous_dir" || die "cannot restore working directory $watchdog_previous_dir"
  if [ "$watchdog_status" -eq 124 ]; then
    printf '%s\n' '===IMPL:QUESTION===' >> "$CYCLE_DIR/sentinels.log" \
      || die "cannot append timeout sentinel to $CYCLE_DIR/sentinels.log"
    printf '%s\n' '===IMPL:QUESTION===' >&2
    die "test command timed out after TEST_TIMEOUT=$test_timeout seconds; inspect the child command before resuming" 5
  fi
  return "$watchdog_status"
}

run_selected() {
  selected_file=$1
  selected_name=$2
  output_file=$3
  case "$stack" in
    node)
      selected_rx="^$(escape_regex "$selected_name")\$"
      run_with_watchdog "$output_file" sh -c "$test_one_cmd"' --test-name-pattern="$1" -- "$2"' rgr "$selected_rx" "$selected_file"
      ;;
    python)
      run_with_watchdog "$output_file" sh -c "$test_one_cmd"' "$1"' rgr "$selected_file::$selected_name"
      ;;
    *)
      die "unsupported STACK=$stack; configure an adapter"
      ;;
  esac
  return $?
}

tap_total() {
  awk -v key="$1" '$1 == "#" && $2 == key { value=$3 } END { if (value != "") print value }' "$2"
}

tap_is_file_failure() {
  tap_file=$1
  tap_basename=$(basename "$tap_file")
  awk -v file="$tap_file" -v base="$tap_basename" '
    /^not ok [0-9]+ - / {
      name = $0
      sub(/^not ok [0-9]+ - /, "", name)
      if (name == file || name == base) found = 1
    }
    END { exit(found ? 0 : 1) }
  ' "$2"
}

tap_selected_failure() {
  selected_name=$1
  selected_output=$2
  RGR_TAP_WANTED=$selected_name awk '
    BEGIN { selected = ENVIRON["RGR_TAP_WANTED"] }
    /^not ok [0-9]+ - / {
      payload = $0
      sub(/^not ok [0-9]+ - /, "", payload)
      name = ""
      escaped = 0
      for (i = 1; i <= length(payload); i++) {
        char = substr(payload, i, 1)
        if (escaped) { name = name char; escaped = 0 }
        else if (char == "\\") escaped = 1
        else if (char == "#") break
        else name = name char
      }
      sub(/[[:space:]]+$/, "", name)
      if (name == selected) {
        print name
        found = 1
      }
    }
    END { exit(found ? 0 : 1) }
  ' "$selected_output"
}

classify_red() {
  classified_file=$1
  classified_output=$2
  case "$pass_format" in
    node-tap)
      classified_tests=$(tap_total tests "$classified_output")
      if [ -z "$classified_tests" ] || [ "$classified_tests" -eq 0 ]; then
        echo broken
        return
      fi
      if tap_is_file_failure "$classified_file" "$classified_output"; then
        echo broken
      else
        echo assertion
      fi
      ;;
    *)
      die "RED classification is not implemented for PASS_FORMAT=$pass_format"
      ;;
  esac
}

next_cycle_number() {
  ref_prefix="refs/rgr/$cycle_id/"
  last_cycle=$(git -C "$worktree" for-each-ref --format='%(refname)' "$ref_prefix" \
    | awk -F/ -v prefix="$ref_prefix" 'index($0, prefix) == 1 && $4 ~ /^[0-9]+$/ { print $4 }' \
    | sort -n | tail -1)
  if [ -z "$last_cycle" ]; then
    echo 1
  else
    echo $((last_cycle + 1))
  fi
}

snapshot_phase() {
  snapshot_cycle=$1
  snapshot_phase_name=$2
  snapshot_tree=$(build_tree) || return $?
  anchor_tree "$snapshot_cycle" "$snapshot_phase_name" "$snapshot_tree" || return $?
  printf '%s' "$snapshot_tree"
}

build_tree() {
  index_file="$CYCLE_DIR/.rgr-index"
  GIT_INDEX_FILE="$index_file" git -C "$worktree" read-tree HEAD >/dev/null 2>&1 \
    || die "cannot seed the RGR snapshot index from HEAD"
  set -- .
  for excluded_path in $snapshot_exclude; do
    set -- "$@" ":(exclude)$excluded_path"
  done
  GIT_INDEX_FILE="$index_file" git -C "$worktree" -c core.excludesFile=/dev/null add -A -- "$@" >/dev/null 2>&1 \
    || die "cannot add the worktree to the RGR snapshot index"
  GIT_INDEX_FILE="$index_file" git -C "$worktree" write-tree 2>/dev/null \
    || die "cannot write the RGR tree"
}

anchor_object() {
  anchor_ref=$1
  anchor_value=$2
  zero=0000000000000000000000000000000000000000
  git -C "$worktree" update-ref "$anchor_ref" "$anchor_value" "$zero" >/dev/null 2>&1 \
    || die "cannot anchor $anchor_ref; another phase may be running"
}

anchor_tree() {
  anchor_cycle=$1
  anchor_phase=$2
  anchor_value=$3
  anchor_object "refs/rgr/$cycle_id/$anchor_cycle/$anchor_phase" "$anchor_value"
}

anchor_blob() {
  blob_label=$1
  blob_ref=$2
  blob_file=$3
  anchored_blob=$(git -C "$worktree" hash-object -w --stdin < "$blob_file") \
    || die "cannot write the $blob_label blob"
  anchor_object "$blob_ref" "$anchored_blob"
  printf '%s' "$anchored_blob"
}

anchor_failset() {
  failset_cycle=$1
  failset_phase=$2
  failset_file=$3
  anchor_blob "normalized $failset_phase failure-set" \
    "refs/rgr/$cycle_id/$failset_cycle/$failset_phase-failset" "$failset_file"
}

anchor_run() {
  run_cycle=$1
  run_phase=$2
  run_file=$3
  anchor_blob "raw $run_phase targeted run" \
    "refs/rgr/$cycle_id/$run_cycle/$run_phase-run/targeted" "$run_file"
}

materialize_blob() {
  materialize_label=$1
  materialize_sha=$2
  materialize_target=$3
  git -C "$worktree" cat-file blob "$materialize_sha" > "$materialize_target" \
    || die "cannot read anchored $materialize_label blob $materialize_sha"
}

anchor_baseline() {
  baseline_source=$1
  baseline_blob=$(git -C "$worktree" hash-object -w --stdin < "$baseline_source") \
    || die "cannot write the normalized baseline failure-set blob"
  baseline_prefix="refs/rgr/$cycle_id/baseline/"
  previous_number=$(git -C "$worktree" for-each-ref --format='%(refname)' "$baseline_prefix" \
    | awk -F/ '$5 ~ /^[0-9][0-9][0-9]$/ { print $5 }' \
    | LC_ALL=C sort | tail -1)
  if [ -z "$previous_number" ]; then
    baseline_number=001
  else
    next_number=$((10#$previous_number + 1))
    [ "$next_number" -le 999 ] || die "baseline capture limit of 999 reached"
    baseline_number=$(printf '%03d' "$next_number")
  fi
  anchor_object "$baseline_prefix$baseline_number" "$baseline_blob"
  git -C "$worktree" update-ref "${baseline_prefix}current" "$baseline_blob" >/dev/null 2>&1 \
    || die "cannot update ${baseline_prefix}current"
}

ensure_log_header() {
  log_file="$CYCLE_DIR/rgr.log"
  if [ ! -s "$log_file" ]; then
    rgr_log_header > "$log_file"
  fi
}

find_open_cycle() {
  open_cycle=''
  for red_ref in $(git -C "$worktree" for-each-ref --format='%(refname)' "refs/rgr/$cycle_id/*/red"); do
    candidate=$(printf '%s' "$red_ref" | awk -F/ '{print $4}')
    if ! git -C "$worktree" show-ref --verify --quiet "refs/rgr/$cycle_id/$candidate/refactor"; then
      [ -z "$open_cycle" ] || die "multiple open RGR cycles found; run repair before continuing"
      open_cycle=$candidate
    fi
  done
  [ -n "$open_cycle" ] || die "no open RGR cycle; run red first"
}

env_execution_contract() {
  awk '!/^BASELINE_(FAILSET|FAILURES_N|AT)=/' "$1"
}

require_cycle_env() {
  required_cycle=$1
  required_header=$(rgr_log_cycle_header "$CYCLE_DIR/rgr.log" "$required_cycle") \
    || die "cycle $required_cycle has no log header; run repair"
  required_env=$(rgr_log_plain_field "$required_header" env 2>/dev/null || true)
  case "$required_env" in
    ''|*[!0-9a-f]*) die "cycle $required_cycle has no anchored env; its phases cannot continue" 2 ;;
  esac
  [ "${#required_env}" -eq 40 ] \
    || die "cycle $required_cycle has invalid anchored env $required_env" 2
  required_env_ref="refs/rgr/$cycle_id/$required_cycle/env"
  required_env_ref_value=$(git -C "$worktree" rev-parse "$required_env_ref" 2>/dev/null) \
    || die "cycle $required_cycle anchored env ref is missing" 2
  [ "$required_env_ref_value" = "$required_env" ] \
    || die "cycle $required_cycle env log/ref mismatch" 2
  actual_env=$(git -C "$worktree" hash-object "$env_file" 2>/dev/null) \
    || die "cannot hash current slot environment $env_file"
  if [ "$actual_env" != "$required_env" ]; then
    required_env_file=$(mktemp "$CYCLE_DIR/.rgr-anchored-env.XXXXXX") \
      || die "cannot create anchored env scratch file"
    materialize_blob "slot environment" "$required_env" "$required_env_file"
    required_contract=$(env_execution_contract "$required_env_file")
    actual_contract=$(env_execution_contract "$env_file")
    if [ "$actual_contract" != "$required_contract" ]; then
      required_suite_count=$(awk -F= '$1 == "TEST_CMD_N" { print $2; exit }' "$required_env_file")
      actual_suite_count=$(env_get TEST_CMD_N)
      if [ "$required_suite_count" != "$actual_suite_count" ]; then
        die "suite count changed from $required_suite_count to $actual_suite_count; slot environment changed after RED" 2
      fi
      die "slot environment changed after RED; restore anchored env $required_env before continuing" 2
    fi
  fi
}

write_red_entry() {
  red_cycle=$1
  red_tree=$2
  red_class=$3
  red_output=$4
  red_env_blob=$5
  red_tests=$(tap_total tests "$red_output")
  red_pass=$(tap_total pass "$red_output")
  red_fail=$(tap_total fail "$red_output")
  red_skipped=$(tap_total skipped "$red_output")
  red_todo=$(tap_total todo "$red_output")
  red_first=$(awk '/^not ok [0-9]+ - / { print; exit }' "$red_output")
  red_hash=$(git hash-object "$0" | cut -c1-7)
  red_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  ensure_log_header
  set -- RED at "$red_at" hash "$red_hash" cmd "$test_one_cmd" exit "$test_exit" \
    class "$red_class" tests "${red_tests:-0}" pass "${red_pass:-0}" fail "${red_fail:-0}" \
    skipped "${red_skipped:-0}" todo "${red_todo:-0}" directive none first "$red_first" \
    name "$test_name" test-file "$test_file" run-targeted "$red_run_blob" tree "$red_tree"
  if [ -n "$allow_import" ]; then
    set -- "$@" allow-import-red "$allow_import"
  fi
  rgr_log_build CYCLE "$red_cycle" repo "$slot" env "$red_env_blob" behavior "$behavior" >> "$log_file"
  rgr_log_build "$@" >> "$log_file"
}

tap_directive_for_name() {
  wanted_name=$1
  RGR_TAP_WANTED=$wanted_name awk '
    BEGIN { wanted = ENVIRON["RGR_TAP_WANTED"] }
    /^(not )?ok [0-9]+ - / {
      payload = $0
      sub(/^(not )?ok [0-9]+ - /, "", payload)
      name = ""
      directive = "none"
      escaped = 0
      for (i = 1; i <= length(payload); i++) {
        char = substr(payload, i, 1)
        if (escaped) {
          name = name char
          escaped = 0
        } else if (char == "\\") {
          escaped = 1
        } else if (char == "#") {
          marker = substr(payload, i + 1)
          if (marker ~ /^[[:space:]]*SKIP/) directive = "SKIP"
          else if (marker ~ /^[[:space:]]*TODO/) directive = "TODO"
          break
        } else {
          name = name char
        }
      }
      sub(/[[:space:]]+$/, "", name)
      if (name == wanted) {
        print directive
        exit
      }
    }
  ' "$2"
}

run_suite_with_reporter() {
  reporter=$1
  command=$2
  output=$3
  run_with_watchdog "$output" env \
    "NODE_OPTIONS=${NODE_OPTIONS:+$NODE_OPTIONS }--test-reporter=$reporter" sh -c "$command"
}

load_current_baseline() {
  [ -n "$baseline_failset" ] \
    || die "failure baseline is absent; run rgr baseline from this pane before GREEN"
  baseline_current_ref="refs/rgr/$cycle_id/baseline/current"
  baseline_blob_used=$(git -C "$worktree" rev-parse "$baseline_current_ref" 2>/dev/null) \
    || die "anchored failure baseline is absent; run rgr baseline from this pane"
  [ "$baseline_failset" = "$baseline_blob_used" ] \
    || die "BASELINE_FAILSET does not match $baseline_current_ref; re-capture with rgr baseline"
  baseline_reference_set=$(mktemp "$CYCLE_DIR/.rgr-baseline.XXXXXX") \
    || die "cannot create baseline failure-set scratch file"
  materialize_blob "failure baseline" "$baseline_blob_used" "$baseline_reference_set"
}

run_suites() {
  new_fail_count=0
  load_current_baseline
  suite_failure_set=$(mktemp "$CYCLE_DIR/.rgr-current-failures.XXXXXX") || die "cannot create current failure-set file"
  capture_failure_set "$suite_failure_set"
  new_failures=$(comm -13 "$baseline_reference_set" "$suite_failure_set")
  if [ -n "$new_failures" ]; then
    new_fail_count=$(printf '%s\n' "$new_failures" | wc -l | tr -d ' ')
    echo "rgr: suite introduced $new_fail_count failure(s):" >&2
    printf '%s\n' "$new_failures" >&2
    die "new failures are not in the baseline; if they are environmental, re-capture from this pane with rgr baseline" 2
  fi
}

anchor_suite_runs() {
  suite_run_cycle=$1
  suite_run_phase=$2
  suite_run_args=()
  suite_status_args=()
  suite_run_index=1
  while [ "$suite_run_index" -le "$suite_count" ]; do
    suite_run_blob=$(anchor_blob "raw $suite_run_phase suite $suite_run_index run" \
      "refs/rgr/$cycle_id/$suite_run_cycle/$suite_run_phase-run/suite-$suite_run_index" \
      "${suite_output_files[$suite_run_index]}") || return $?
    [ -n "$suite_run_blob" ] || return 1
    suite_run_args+=("run-suite-$suite_run_index" "$suite_run_blob")
    suite_status_blob=$(anchor_blob "raw $suite_run_phase suite $suite_run_index process status" \
      "refs/rgr/$cycle_id/$suite_run_cycle/$suite_run_phase-status/suite-$suite_run_index" \
      "${suite_status_files[$suite_run_index]}") || return $?
    [ -n "$suite_status_blob" ] || return 1
    suite_status_args+=("status-suite-$suite_run_index" "$suite_status_blob")
    suite_run_index=$((suite_run_index + 1))
  done
}

write_green_entry() {
  green_cycle=$1
  green_tree=$2
  green_hash=$(git hash-object "$0" | cut -c1-7)
  green_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  rgr_log_build GREEN at "$green_at" hash "$green_hash" failset "$green_failset_blob" \
    baseline "$baseline_blob_used" run-targeted "$green_targeted_run_blob" "${suite_run_args[@]}" \
    "${suite_status_args[@]}" "${suite_exit_args[@]}" \
    target-exit 0 target-tests "$directed_tests" target-pass "$directed_pass" \
    target-fail "$directed_fail" skipped "$directed_skipped" todo "$directed_todo" \
    name-ok yes directive "$green_directive" tests-diff EMPTY suite-tests "$suite_tests" \
    suite-fail "$suite_fail" new-fails "$new_fail_count" tree "$green_tree" >> "$CYCLE_DIR/rgr.log"
}

write_refactor_entry() {
  refactor_tree=$1
  refactor_hash=$(git hash-object "$0" | cut -c1-7)
  refactor_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  rgr_log_build REFACTOR at "$refactor_at" hash "$refactor_hash" failset "$refactor_failset_blob" \
    baseline "$refactor_baseline_blob" failset-diff EMPTY "${suite_run_args[@]}" \
    "${suite_status_args[@]}" "${suite_exit_args[@]}" exit 0 \
    suite-tests "$suite_tests" pass "$suite_pass" suite-fail "$suite_fail" same yes tests-diff EMPTY \
    tree "$refactor_tree" note "$refactor_note" >> "$CYCLE_DIR/rgr.log"
}

junit_failures() {
  awk -v root="$worktree/" '
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
  ' "$1"
}

junit_total() {
  awk -v key="$1" '$1 == "<!--" && $2 == key { value=$3 } END { if (value != "") print value }' "$2"
}

expected_suite_exit() {
  if [ "$1" -gt 0 ]; then printf '1'; else printf '0'; fi
}

capture_failure_set() {
  capture_target=$1
  suite_output_files=()
  suite_status_files=()
  suite_exit_args=()
  suite_tests=0
  suite_pass=0
  suite_fail=0
  suite_skipped=0
  suite_todo=0
  capture_unsorted=$(mktemp "$CYCLE_DIR/.rgr-failures.XXXXXX") || die "cannot create failure-set scratch file"
  : > "$capture_unsorted"
  suite_count=$(env_get TEST_CMD_N)
  suite_index=1
  while [ "$suite_index" -le "$suite_count" ]; do
    suite_cmd=$(env_get "TEST_CMD_$suite_index")
    suite_output=$(mktemp "$CYCLE_DIR/.rgr-suite.XXXXXX") || die "cannot create suite output file"
    suite_output_files[$suite_index]=$suite_output
    case "$failset_format" in
      node-junit)
        run_suite_with_reporter junit "$suite_cmd" "$suite_output"
        current_exit=$?
        junit_failures "$suite_output" >> "$capture_unsorted"
        current_tests=$(junit_total tests "$suite_output")
        current_pass=$(junit_total pass "$suite_output")
        current_fail=$(junit_total fail "$suite_output")
        current_skipped=$(junit_total skipped "$suite_output")
        current_todo=$(junit_total todo "$suite_output")
        [ -n "$current_tests" ] || die "suite $suite_index has no parseable JUnit summary" 2
        [ "$current_tests" -gt 0 ] || die "suite $suite_index reported tests=0; its glob matched no tests" 2
        expected_exit=$(expected_suite_exit "$current_fail")
        [ "$current_exit" -eq "$expected_exit" ] \
          || die "suite $suite_index exited $current_exit but JUnit reports fail=$current_fail (expected exit $expected_exit)" 2
        suite_status=$(mktemp "$CYCLE_DIR/.rgr-suite-status.XXXXXX") \
          || die "cannot create suite $suite_index status file"
        printf '%s\n' "$current_exit" > "$suite_status" \
          || die "cannot write suite $suite_index status file"
        suite_status_files[$suite_index]=$suite_status
        suite_exit_args+=("suite-exit-$suite_index" "$current_exit")
        suite_tests=$((suite_tests + current_tests))
        suite_pass=$((suite_pass + current_pass))
        suite_fail=$((suite_fail + current_fail))
        suite_skipped=$((suite_skipped + current_skipped))
        suite_todo=$((suite_todo + current_todo))
        ;;
      *) die "failure-set capture is not implemented for FAILSET_FORMAT=$failset_format" ;;
    esac
    suite_index=$((suite_index + 1))
  done
  LC_ALL=C sort -u "$capture_unsorted" > "$capture_target"
}

update_baseline_env() {
  baseline_count=$1
  baseline_time=$2
  baseline_sha=$3
  baseline_tmp=$(mktemp "$CYCLE_DIR/.rgr-env.XXXXXX") || die "cannot create baseline env scratch file"
  awk -v count="$baseline_count" -v at="$baseline_time" -v failset="$baseline_sha" '
    /^BASELINE_FAILSET=/ { print "BASELINE_FAILSET=" failset; next }
    /^BASELINE_FAILURES_N=/ { print "BASELINE_FAILURES_N=" count; next }
    /^BASELINE_AT=/ { print "BASELINE_AT=" at; next }
    { print }
  ' "$env_file" > "$baseline_tmp" || die "cannot update baseline metadata"
  mv "$baseline_tmp" "$env_file" || die "cannot replace $env_file with baseline metadata"
}

require_same_failure_set() {
  expected_set=$1
  actual_set=$2
  added_failures=$(comm -13 "$expected_set" "$actual_set")
  removed_failures=$(comm -23 "$expected_set" "$actual_set")
  if [ -n "$added_failures" ] || [ -n "$removed_failures" ]; then
    echo "rgr: failure set changed during REFACTOR" >&2
    [ -z "$added_failures" ] || { echo 'rgr: added:' >&2; printf '%s\n' "$added_failures" >&2; }
    [ -z "$removed_failures" ] || { echo 'rgr: removed:' >&2; printf '%s\n' "$removed_failures" >&2; }
    exit 2
  fi
}

restore_path_from_tree() {
  restore_tree=$1
  restore_path=$2
  restore_target="$worktree/$restore_path"
  if git -C "$worktree" cat-file -e "$restore_tree:$restore_path" 2>/dev/null; then
    mkdir -p "$(dirname "$restore_target")" || return 1
    git -C "$worktree" cat-file blob "$restore_tree:$restore_path" > "$restore_target" || return 1
  else
    rm -f "$restore_target" || return 1
  fi
}

require_green_fix_file() {
  required_tree=$1
  required_path=$2
  case "$required_path" in /*|../*|*/../*) die "--fix-file must be a worktree-relative path without ..: $required_path" ;; esac
  green_blob=$(git -C "$worktree" rev-parse "$required_tree:$required_path" 2>/dev/null) \
    || die "--fix-file is absent from the GREEN tree: $required_path" 2
  current_blob=$(git -C "$worktree" hash-object "$worktree/$required_path" 2>/dev/null) \
    || die "cannot hash current --fix-file: $required_path"
  [ "$current_blob" = "$green_blob" ] || die "--fix-file differs from the GREEN tree: $required_path" 2
}

anchor_catches_evidence() {
  catches_cycle=$1
  catches_output=$2
  catches_test_file=$3
  catches_test_name=$4
  catches_run_blob=$(anchor_blob "raw catches targeted run" \
    "refs/rgr/$cycle_id/$catches_cycle/catches-run/targeted" "$catches_output") || return $?
  catches_set=$(mktemp "$CYCLE_DIR/.rgr-catches-failures.XXXXXX") \
    || die "cannot create catches failure-set scratch file"
  tap_selected_failure "$catches_test_name" "$catches_output" \
    | awk -v file="$catches_test_file" '{ print file "::" $0 }' \
    | LC_ALL=C sort -u > "$catches_set"
  catches_failset_blob=$(anchor_blob "normalized catches failure-set" \
    "refs/rgr/$cycle_id/$catches_cycle/catches-failset" "$catches_set") || return $?
  printf '%s %s' "$catches_run_blob" "$catches_failset_blob"
}

cycle_id=$(basename "$CYCLE_DIR")
cycle_id=${cycle_id#tmux-worker-cycle-}
inflight_file="$CYCLE_DIR/.rgr-catches-inflight"
if [ -f "$inflight_file" ] && [ "$subcommand" != repair ]; then
  die "interrupted verify-catches state found at $inflight_file; run rgr repair before any other phase"
fi

case "$subcommand" in
  baseline)
    [ "$#" -eq 0 ] || die "baseline takes no arguments"
    baseline_capture_set=$(mktemp "$CYCLE_DIR/.rgr-baseline-capture.XXXXXX") \
      || die "cannot create baseline capture scratch file"
    capture_failure_set "$baseline_capture_set"
    anchor_baseline "$baseline_capture_set"
    baseline_count=$(wc -l < "$baseline_capture_set" | tr -d ' ')
    baseline_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    update_baseline_env "$baseline_count" "$baseline_at" "$baseline_blob"
    ensure_log_header
    rgr_log_build BASELINE at "$baseline_at" slot "$slot" seq "$baseline_number" \
      failset "$baseline_blob" fails "$baseline_count" by impl >> "$CYCLE_DIR/rgr.log"
    echo "rgr: captured baseline slot=$slot fails=$baseline_count failset=$baseline_blob"
    ;;
  red)
    behavior=${1:-}
    [ -n "$behavior" ] || die "red requires <behavior> first"
    shift
    test_file=''
    test_name=''
    allow_import=''
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --test-file) [ "$#" -ge 2 ] || die "--test-file requires a path"; test_file=$2; shift 2 ;;
        --name) [ "$#" -ge 2 ] || die "--name requires a test name"; test_name=$2; shift 2 ;;
        --allow-import-red) [ "$#" -ge 2 ] || die "--allow-import-red requires a reason"; allow_import=$2; shift 2 ;;
        *) die "unknown red argument: $1" ;;
      esac
    done
    [ -n "$test_file" ] || die "red requires --test-file <path>"
    [ -n "$test_name" ] || die "red requires --name <name>"
    validate_test_name "$test_name"
    [ "$pass_format" != none ] || die "PASS_FORMAT=none cannot classify RED; configure an explicit format"
    output_file=$(mktemp "$CYCLE_DIR/.rgr-output.XXXXXX") || die "cannot create test output file"
    run_selected "$test_file" "$test_name" "$output_file"
    test_exit=$?
    if [ "$test_exit" -eq 0 ]; then
      selected_name_result=$(tap_directive_for_name "$test_name" "$output_file")
      if [ -z "$selected_name_result" ]; then
        selected_pass=$(tap_total pass "$output_file")
        echo "rgr: selected-name name-ok=no pass=${selected_pass:-missing}" >&2
      fi
      echo "rgr: RED passed on the first run; the behavior already exists, the test asserts nothing, or it asserts the wrong thing" >&2
      exit 2
    fi
    red_class=$(classify_red "$test_file" "$output_file") || exit $?
    if [ "$red_class" = broken ] && [ -z "$allow_import" ]; then
      die "RED rejected: class=broken; fix collection or module loading before recording the cycle" 3
    fi
    cycle_number=$(next_cycle_number)
    red_tree=$(snapshot_phase "$cycle_number" red) || exit $?
    require_evidence_id "RED tree" "$red_tree"
    red_run_blob=$(anchor_run "$cycle_number" red "$output_file") || exit $?
    require_evidence_id "RED run" "$red_run_blob"
    cycle_env_blob=$(anchor_blob "slot environment" \
      "refs/rgr/$cycle_id/$cycle_number/env" "$env_file") || exit $?
    require_evidence_id "slot environment" "$cycle_env_blob"
    write_red_entry "$cycle_number" "$red_tree" "$red_class" "$output_file" "$cycle_env_blob"
    echo "rgr: recorded RED cycle=$cycle_number class=$red_class tree=$red_tree"
    ;;
  green)
    find_open_cycle
    red_line=$(rgr_log_phase_line "$CYCLE_DIR/rgr.log" "$open_cycle" RED)
    [ -n "$red_line" ] || die "open cycle $open_cycle has no RED log line; run repair"
    red_header=$(rgr_log_cycle_header "$CYCLE_DIR/rgr.log" "$open_cycle") \
      || die "open cycle $open_cycle has no log header; run repair"
    red_slot=$(rgr_log_plain_field "$red_header" repo)
    [ "$red_slot" = "$slot" ] || die "open cycle $open_cycle belongs to slot '$red_slot', not cwd slot '$slot'" 2
    require_cycle_env "$open_cycle"
    red_file=$(rgr_log_quoted_field "$red_line" test-file) || die "cannot read test-file from RED cycle $open_cycle"
    red_name=$(rgr_log_quoted_field "$red_line" name) || die "cannot read name from RED cycle $open_cycle"
    green_file=$red_file
    green_name=$red_name
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --test-file) [ "$#" -ge 2 ] || die "--test-file requires a path"; [ "$2" = "$red_file" ] || die "green --test-file differs from the open RED"; green_file=$2; shift 2 ;;
        --name) [ "$#" -ge 2 ] || die "--name requires a test name"; [ "$2" = "$red_name" ] || die "green --name differs from the open RED"; green_name=$2; shift 2 ;;
        *) die "unknown green argument: $1" ;;
      esac
    done
    output_file=$(mktemp "$CYCLE_DIR/.rgr-output.XXXXXX") || die "cannot create test output file"
    run_selected "$green_file" "$green_name" "$output_file"
    test_exit=$?
    if [ "$test_exit" -ne 0 ]; then
      die "selected test is still red; implement the behavior before GREEN" 2
    fi
    directed_tests=$(tap_total tests "$output_file")
    directed_pass=$(tap_total pass "$output_file")
    directed_fail=$(tap_total fail "$output_file")
    directed_skipped=$(tap_total skipped "$output_file")
    directed_todo=$(tap_total todo "$output_file")
    [ -n "$directed_tests" ] && [ "$directed_tests" -gt 0 ] || die "selected run reported tests=0; the selector matched no tests" 2
    green_directive=$(tap_directive_for_name "$green_name" "$output_file")
    [ -n "$green_directive" ] || die "selected RED name was not reported ok; the test may have been renamed or removed" 2
    [ "$green_directive" = none ] || die "selected test was marked # $green_directive instead of executing" 2
    [ "${directed_skipped:-0}" -eq 0 ] || die "selected run reported skipped=$directed_skipped" 2
    [ "${directed_todo:-0}" -eq 0 ] || die "selected run reported todo=$directed_todo" 2
    [ "${directed_pass:-0}" -ge 1 ] || die "selected run reported pass=0" 2
    candidate_tree=$(build_tree) || exit $?
    require_evidence_id "GREEN tree" "$candidate_tree"
    red_tree=$(git -C "$worktree" rev-parse "refs/rgr/$cycle_id/$open_cycle/red") || die "cannot resolve RED tree for cycle $open_cycle"
    test_globs=$(env_get TEST_GLOBS)
    test_changes=$(git -C "$worktree" diff-tree -r --name-only "$red_tree" "$candidate_tree" -- $test_globs)
    [ -z "$test_changes" ] || die "tests changed between RED and GREEN: $test_changes" 2
    run_suites
    green_targeted_run_blob=$(anchor_blob "raw green targeted run" \
      "refs/rgr/$cycle_id/$open_cycle/green-run/targeted" "$output_file") || exit $?
    require_evidence_id "GREEN targeted run" "$green_targeted_run_blob"
    anchor_suite_runs "$open_cycle" green || exit $?
    green_failset_blob=$(anchor_failset "$open_cycle" green "$suite_failure_set") || exit $?
    require_evidence_id "GREEN failure-set" "$green_failset_blob"
    anchor_tree "$open_cycle" green "$candidate_tree"
    write_green_entry "$open_cycle" "$candidate_tree"
    echo "rgr: recorded GREEN cycle=$open_cycle tests=$suite_tests pass=$suite_pass tree=$candidate_tree"
    ;;
  verify-catches)
    fix_files=()
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --fix-file) [ "$#" -ge 2 ] || die "--fix-file requires a path"; fix_files+=("$2"); shift 2 ;;
        *) die "unknown verify-catches argument: $1" ;;
      esac
    done
    [ "${#fix_files[@]}" -gt 0 ] || die "verify-catches requires at least one --fix-file <path>"
    find_open_cycle
    require_cycle_env "$open_cycle"
    green_ref="refs/rgr/$cycle_id/$open_cycle/green"
    git -C "$worktree" show-ref --verify --quiet "$green_ref" || die "cycle $open_cycle has no GREEN; run green before verify-catches" 2
    red_tree=$(git -C "$worktree" rev-parse "refs/rgr/$cycle_id/$open_cycle/red") || die "cannot resolve RED tree"
    green_tree=$(git -C "$worktree" rev-parse "$green_ref") || die "cannot resolve GREEN tree"
    new_file_seen=no
    for fix_file in "${fix_files[@]}"; do
      require_green_fix_file "$green_tree" "$fix_file"
      git -C "$worktree" cat-file -e "$red_tree:$fix_file" 2>/dev/null || new_file_seen=yes
    done
    inflight_file="$CYCLE_DIR/.rgr-catches-inflight"
    {
      printf 'repo=%s\ngreen=%s\nred=%s\n' "$slot" "$green_tree" "$red_tree"
      for fix_file in "${fix_files[@]}"; do
        printf 'file=%s\n' "$fix_file"
      done
    } > "$inflight_file" || die "cannot write $inflight_file"
    restore_catches() {
      for restore_file in "${fix_files[@]}"; do
        restore_path_from_tree "$green_tree" "$restore_file" || true
      done
      rm -f "$inflight_file"
    }
    trap restore_catches EXIT INT TERM
    for fix_file in "${fix_files[@]}"; do
      restore_path_from_tree "$red_tree" "$fix_file" || die "cannot restore RED blob for $fix_file"
    done
    red_line=$(rgr_log_phase_line "$CYCLE_DIR/rgr.log" "$open_cycle" RED)
    catches_file=$(rgr_log_quoted_field "$red_line" test-file) || die "cannot read test-file from RED cycle $open_cycle"
    catches_name=$(rgr_log_quoted_field "$red_line" name) || die "cannot read name from RED cycle $open_cycle"
    output_file=$(mktemp "$CYCLE_DIR/.rgr-catches.XXXXXX") || die "cannot create catches output file"
    run_selected "$catches_file" "$catches_name" "$output_file"
    catches_exit=$?
    catches_value=no
    catches_reason=''
    catches_failed_selected=no
    tap_selected_failure "$catches_name" "$output_file" >/dev/null \
      && catches_failed_selected=yes
    if [ "$new_file_seen" = yes ]; then
      catches_class=$(classify_red "$catches_file" "$output_file")
      if [ "$catches_class" = broken ]; then
        catches_value=n/a
        catches_reason=new-file
      elif [ "$catches_failed_selected" = yes ]; then
        catches_value=yes
      fi
    elif [ "$catches_failed_selected" = yes ]; then
      catches_value=yes
    fi
    catches_evidence=$(anchor_catches_evidence \
      "$open_cycle" "$output_file" "$catches_file" "$catches_name") || exit $?
    catches_run_blob=${catches_evidence%% *}
    catches_failset_blob=${catches_evidence#* }
    require_evidence_id "CATCHES raw targeted run" "$catches_run_blob"
    require_evidence_id "CATCHES failure-set" "$catches_failset_blob"
    restore_catches
    trap - EXIT INT TERM
    catches_hash=$(git hash-object "$0" | cut -c1-7)
    catches_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    set -- CATCHES at "$catches_at" hash "$catches_hash" catches "$catches_value" \
      files "${fix_files[*]}" catches-failset "$catches_failset_blob" run-targeted "$catches_run_blob"
    [ -z "$catches_reason" ] || set -- "$@" reason "$catches_reason"
    rgr_log_build "$@" >> "$CYCLE_DIR/rgr.log"
    echo "rgr: recorded CATCHES cycle=$open_cycle catches=$catches_value"
    ;;
  repair)
    [ "$#" -eq 0 ] || die "repair takes no arguments"
    [ -f "$inflight_file" ] || die "no repairable RGR state found"
    repair_green=$(awk -F= '$1 == "green" { sub(/^[^=]*=/, ""); print; exit }' "$inflight_file")
    [ -n "$repair_green" ] || repair_green=$(awk '{ for (i=1;i<=NF;i++) if ($i ~ /^green=/) { sub(/^green=/, "", $i); print $i; exit } }' "$inflight_file")
    repair_files=$(sed -n 's/^file=//p' "$inflight_file")
    [ -n "$repair_files" ] || repair_files=$(sed -n 's/^.* files=//p' "$inflight_file")
    [ -n "$repair_green" ] && [ -n "$repair_files" ] || die "invalid catches crumb; inspect $inflight_file"
    while IFS= read -r repair_file; do
      restore_path_from_tree "$repair_green" "$repair_file" || die "cannot restore $repair_file from GREEN during repair"
    done <<EOF
$repair_files
EOF
    rm -f "$inflight_file" || die "cannot remove repaired crumb $inflight_file"
    echo "rgr: repaired interrupted verify-catches state from GREEN $repair_green"
    ;;
  refactor)
    [ "$#" -eq 1 ] || die "refactor requires exactly one note"
    refactor_note=$1
    find_open_cycle
    require_cycle_env "$open_cycle"
    green_ref="refs/rgr/$cycle_id/$open_cycle/green"
    git -C "$worktree" show-ref --verify --quiet "$green_ref" || die "cycle $open_cycle has no GREEN; run green before refactor" 2
    suite_failure_set=$(mktemp "$CYCLE_DIR/.rgr-current-failures.XXXXXX") || die "cannot create current failure-set file"
    capture_failure_set "$suite_failure_set"
    candidate_tree=$(build_tree) || exit $?
    require_evidence_id "REFACTOR tree" "$candidate_tree"
    green_tree=$(git -C "$worktree" rev-parse "$green_ref") || die "cannot resolve GREEN tree for cycle $open_cycle"
    test_globs=$(env_get TEST_GLOBS)
    test_changes=$(git -C "$worktree" diff-tree -r --name-only "$green_tree" "$candidate_tree" -- $test_globs)
    if [ -n "$test_changes" ]; then
      die "test files changed during REFACTOR ($test_changes); that is a behavior change, not a refactor" 2
    fi
    green_line=$(rgr_log_phase_line "$CYCLE_DIR/rgr.log" "$open_cycle" GREEN)
    [ -n "$green_line" ] || die "cycle $open_cycle has no GREEN log line; run repair"
    green_suite_count=$(rgr_log_indexed_fields "$green_line" run-suite- | wc -l | tr -d ' ')
    [ "$suite_count" -eq "$green_suite_count" ] \
      || die "suite count changed from $green_suite_count to $suite_count; REFACTOR must use the same indexed suite universe as GREEN" 2
    refactor_baseline_blob=$(rgr_log_plain_field "$green_line" baseline)
    git -C "$worktree" cat-file -e "$refactor_baseline_blob^{blob}" 2>/dev/null \
      || die "GREEN baseline blob is missing for cycle $open_cycle"
    green_tests=$(rgr_log_plain_field "$green_line" suite-tests)
    if [ "$suite_tests" != "$green_tests" ]; then
      die "suite test count changed from $green_tests to $suite_tests; adding, removing, or extracting subtests is behavior and needs a RED cycle" 2
    fi
    green_failset_ref="refs/rgr/$cycle_id/$open_cycle/green-failset"
    green_failset_blob=$(git -C "$worktree" rev-parse "$green_failset_ref") \
      || die "cannot resolve GREEN failure-set blob for cycle $open_cycle"
    green_failure_set=$(mktemp "$CYCLE_DIR/.rgr-green-failures.XXXXXX") || die "cannot create GREEN failure-set scratch file"
    materialize_blob "GREEN failure-set" "$green_failset_blob" "$green_failure_set"
    require_same_failure_set "$green_failure_set" "$suite_failure_set"
    anchor_suite_runs "$open_cycle" refactor || exit $?
    refactor_failset_blob=$(anchor_failset "$open_cycle" refactor "$suite_failure_set") || exit $?
    require_evidence_id "REFACTOR failure-set" "$refactor_failset_blob"
    anchor_tree "$open_cycle" refactor "$candidate_tree"
    write_refactor_entry "$candidate_tree"
    echo "rgr: recorded REFACTOR cycle=$open_cycle tests=$suite_tests pass=$suite_pass tree=$candidate_tree"
    ;;
  *)
    die "subcommand '$subcommand' is not implemented"
    ;;
esac
