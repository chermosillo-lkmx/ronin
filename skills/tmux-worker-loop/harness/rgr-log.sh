#!/usr/bin/env bash
# rgr-log.sh v1
#
# WHY THIS EXISTS
# The rgr.log format changed in revisions 6, 7, 8, and 11, and each change
# broke fixture tests that repeated its literal representation. Revisions 3,
# 5, 9, and 12 exposed the same underlying problem: construction and parsing
# need one owner. This sourced Bash 3.2 library is that owner; it has no
# load-time effects and contains only the log format functions below.
#
# FORMAT FROZEN: 2026-09-10. Any later format change requires Main's explicit
# authorization and must migrate the constructor, parser, verify-rgr.sh, and
# the fixture tests in the same cycle. Main authorized this one thaw because
# JUnit output cannot prove the actual suite process status: a parseable stream
# may still exit 64. Each suite now carries status-suite-N=<anchored blob sha>
# beside suite-exit-N, so the parser and gate can re-derive the scalar from the
# contemporaneous status evidence instead of rewriting what the process did.
# Main authorized the 2026-09-09 env= evidence extension: cycles 1-39 say
# env=unverifiable; cycle 40 onward names an anchored slot-environment blob.
# The explicit frontier prevents current bytes from being presented as
# historical evidence.
#
# TEST-NAME BOUNDARY: literal '#' and '\\' are supported because they occur in
# real test names and TAP escapes them. Control characters are rejected before
# a RED runs: supporting LF, CR, TAB, BS, FF, or VT would compose TAP escaping
# with this log's escaping and recreate the ambiguous nested grammar that the
# one-blob-per-run design exists to avoid. Keep that rejection explicit.

rgr_log_header() {
  printf '%s\n' 'RGRLOG v1'
}

rgr_log_is_quoted_key() {
  case "$1" in
    behavior|note|first|name|test-file|allow-import-red|reason|files|cmd) return 0 ;;
    *) return 1 ;;
  esac
}

rgr_log_escape() {
  local rgr_log_escaped
  rgr_log_escaped=${1//\\/\\\\}
  rgr_log_escaped=${rgr_log_escaped//\"/\\\"}
  printf '%s' "$rgr_log_escaped"
}

rgr_log_build() {
  local rgr_log_record rgr_log_prefix rgr_log_cycle rgr_log_key rgr_log_value
  rgr_log_record=${1:-}
  [ -n "$rgr_log_record" ] || return 1
  shift
  case "$rgr_log_record" in
    HEADER)
      if [ "$#" -eq 2 ]; then
        [ "$1" = version ] && [ "$2" = v1 ] || return 1
      else
        [ "$#" -eq 0 ] || return 1
      fi
      rgr_log_header
      return
      ;;
    BASELINE) rgr_log_prefix='BASELINE' ;;
    CYCLE)
      [ "$#" -ge 3 ] || return 1
      rgr_log_cycle=$1
      shift
      [ "$1" = repo ] || return 1
      rgr_log_prefix="CYCLE $rgr_log_cycle :: repo=$2 ::"
      shift 2
      ;;
    RED) rgr_log_prefix='  RED     ' ;;
    GREEN) rgr_log_prefix='  GREEN   ' ;;
    CATCHES) rgr_log_prefix='  CATCHES ' ;;
    REFACTOR) rgr_log_prefix='  REFACTOR' ;;
    *) return 1 ;;
  esac
  [ $(( $# % 2 )) -eq 0 ] || return 1
  while [ "$#" -gt 0 ]; do
    rgr_log_key=$1
    rgr_log_value=$2
    shift 2
    if rgr_log_is_quoted_key "$rgr_log_key"; then
      rgr_log_prefix="$rgr_log_prefix $rgr_log_key=\"$(rgr_log_escape "$rgr_log_value")\""
    else
      case "$rgr_log_value" in *' '*) return 1 ;; esac
      rgr_log_prefix="$rgr_log_prefix $rgr_log_key=$rgr_log_value"
    fi
  done
  printf '%s\n' "$rgr_log_prefix"
}

rgr_log_parse() {
  local rgr_log_line rgr_log_record rgr_log_rest rgr_log_cycle rgr_log_key
  local rgr_log_value rgr_log_char rgr_log_escaped rgr_log_closed rgr_log_index
  rgr_log_line=${1:-}
  case "$rgr_log_line" in
    'RGRLOG v1')
      printf '%s\n' 'record=HEADER' 'version=v1'
      return
      ;;
    BASELINE\ *) rgr_log_record=BASELINE; rgr_log_rest=${rgr_log_line#BASELINE } ;;
    CYCLE\ *)
      rgr_log_record=CYCLE
      rgr_log_rest=${rgr_log_line#CYCLE }
      rgr_log_cycle=${rgr_log_rest%% *}
      case "$rgr_log_rest" in "$rgr_log_cycle :: "*) ;; *) return 1 ;; esac
      rgr_log_rest=${rgr_log_rest#"$rgr_log_cycle :: "}
      ;;
    '  RED      '*) rgr_log_record=RED; rgr_log_rest=${rgr_log_line#'  RED      '} ;;
    '  GREEN    '*) rgr_log_record=GREEN; rgr_log_rest=${rgr_log_line#'  GREEN    '} ;;
    '  CATCHES  '*) rgr_log_record=CATCHES; rgr_log_rest=${rgr_log_line#'  CATCHES  '} ;;
    '  REFACTOR '*) rgr_log_record=REFACTOR; rgr_log_rest=${rgr_log_line#'  REFACTOR '} ;;
    *) return 1 ;;
  esac

  printf 'record=%s\n' "$rgr_log_record"
  [ "$rgr_log_record" != CYCLE ] || printf 'cycle=%s\n' "$rgr_log_cycle"
  while [ -n "$rgr_log_rest" ]; do
    while [ "${rgr_log_rest# }" != "$rgr_log_rest" ]; do
      rgr_log_rest=${rgr_log_rest# }
    done
    [ -n "$rgr_log_rest" ] || break
    if [ "$rgr_log_record" = CYCLE ] && [ "${rgr_log_rest#:: }" != "$rgr_log_rest" ]; then
      rgr_log_rest=${rgr_log_rest#:: }
      continue
    fi
    rgr_log_key=${rgr_log_rest%%=*}
    [ "$rgr_log_key" != "$rgr_log_rest" ] && [ -n "$rgr_log_key" ] || return 1
    case "$rgr_log_key" in *' '*) return 1 ;; esac
    rgr_log_rest=${rgr_log_rest#*=}
    rgr_log_value=''
    if [ "${rgr_log_rest#\"}" != "$rgr_log_rest" ]; then
      rgr_log_rest=${rgr_log_rest#\"}
      rgr_log_escaped=no
      rgr_log_closed=no
      rgr_log_index=0
      while [ "$rgr_log_index" -lt "${#rgr_log_rest}" ]; do
        rgr_log_char=${rgr_log_rest:$rgr_log_index:1}
        if [ "$rgr_log_escaped" = yes ]; then
          rgr_log_value="$rgr_log_value$rgr_log_char"
          rgr_log_escaped=no
        elif [ "$rgr_log_char" = "\\" ]; then
          rgr_log_escaped=yes
        elif [ "$rgr_log_char" = '"' ]; then
          rgr_log_closed=yes
          rgr_log_index=$((rgr_log_index + 1))
          break
        else
          rgr_log_value="$rgr_log_value$rgr_log_char"
        fi
        rgr_log_index=$((rgr_log_index + 1))
      done
      [ "$rgr_log_closed" = yes ] && [ "$rgr_log_escaped" = no ] || return 1
      rgr_log_rest=${rgr_log_rest:$rgr_log_index}
      case "$rgr_log_rest" in ''|' '*) ;; *) return 1 ;; esac
    else
      case "$rgr_log_rest" in
        *' '*) rgr_log_value=${rgr_log_rest%% *}; rgr_log_rest=${rgr_log_rest#* } ;;
        *) rgr_log_value=$rgr_log_rest; rgr_log_rest='' ;;
      esac
    fi
    printf '%s=%s\n' "$rgr_log_key" "$rgr_log_value"
  done
}

rgr_log_field() {
  local rgr_log_field_line rgr_log_field_key
  rgr_log_field_line=$1
  rgr_log_field_key=$2
  rgr_log_parse "$rgr_log_field_line" | awk -F= -v key="$rgr_log_field_key" '
    $1 == key { sub(/^[^=]*=/, ""); print; found = 1; exit }
    END { if (!found) exit 1 }
  '
}

rgr_log_plain_field() {
  rgr_log_field "$@"
}

rgr_log_quoted_field() {
  rgr_log_field "$@"
}

rgr_log_indexed_fields() {
  local rgr_log_indexed_line rgr_log_indexed_prefix
  rgr_log_indexed_line=$1
  rgr_log_indexed_prefix=$2
  rgr_log_parse "$rgr_log_indexed_line" | awk -F= -v prefix="$rgr_log_indexed_prefix" '
    index($1, prefix) == 1 { print }
  '
}

rgr_log_cycle_numbers() {
  local rgr_log_numbers_file rgr_log_numbers_line rgr_log_numbers_record
  rgr_log_numbers_file=$1
  while IFS= read -r rgr_log_numbers_line; do
    rgr_log_numbers_record=$(rgr_log_field "$rgr_log_numbers_line" record) || return 1
    [ "$rgr_log_numbers_record" != CYCLE ] \
      || rgr_log_field "$rgr_log_numbers_line" cycle
  done < "$rgr_log_numbers_file"
}

rgr_log_validate_header() {
  local rgr_log_validate_file rgr_log_validate_line
  rgr_log_validate_file=$1
  IFS= read -r rgr_log_validate_line < "$rgr_log_validate_file" || return 1
  [ "$(rgr_log_field "$rgr_log_validate_line" record)" = HEADER ] \
    && [ "$(rgr_log_field "$rgr_log_validate_line" version)" = v1 ]
}

rgr_log_records() {
  local rgr_log_records_file rgr_log_records_wanted rgr_log_records_line rgr_log_records_record
  rgr_log_records_file=$1
  rgr_log_records_wanted=$2
  while IFS= read -r rgr_log_records_line; do
    rgr_log_records_record=$(rgr_log_field "$rgr_log_records_line" record) || return 1
    [ "$rgr_log_records_record" != "$rgr_log_records_wanted" ] \
      || printf '%s\n' "$rgr_log_records_line"
  done < "$rgr_log_records_file"
}

rgr_log_first_record() {
  local rgr_log_first_file rgr_log_first_wanted rgr_log_first_line rgr_log_first_record
  rgr_log_first_file=$1
  rgr_log_first_wanted=$2
  while IFS= read -r rgr_log_first_line; do
    rgr_log_first_record=$(rgr_log_field "$rgr_log_first_line" record) || return 1
    if [ "$rgr_log_first_record" = "$rgr_log_first_wanted" ]; then
      printf '%s\n' "$rgr_log_first_line"
      return
    fi
  done < "$rgr_log_first_file"
  return 1
}

rgr_log_cycle_header() {
  local rgr_log_header_file rgr_log_header_cycle rgr_log_header_line rgr_log_header_record
  rgr_log_header_file=$1
  rgr_log_header_cycle=$2
  while IFS= read -r rgr_log_header_line; do
    rgr_log_header_record=$(rgr_log_field "$rgr_log_header_line" record) || return 1
    if [ "$rgr_log_header_record" = CYCLE ] \
      && [ "$(rgr_log_field "$rgr_log_header_line" cycle)" = "$rgr_log_header_cycle" ]; then
      printf '%s\n' "$rgr_log_header_line"
      return
    fi
  done < "$rgr_log_header_file"
  return 1
}

rgr_log_phase_line() {
  local rgr_log_phase_file rgr_log_phase_cycle rgr_log_phase_name
  local rgr_log_phase_line_value rgr_log_phase_record rgr_log_phase_inside
  rgr_log_phase_file=$1
  rgr_log_phase_cycle=$2
  rgr_log_phase_name=$3
  rgr_log_phase_inside=no
  while IFS= read -r rgr_log_phase_line_value; do
    rgr_log_phase_record=$(rgr_log_field "$rgr_log_phase_line_value" record) || return 1
    if [ "$rgr_log_phase_record" = CYCLE ]; then
      if [ "$(rgr_log_field "$rgr_log_phase_line_value" cycle)" = "$rgr_log_phase_cycle" ]; then
        rgr_log_phase_inside=yes
      elif [ "$rgr_log_phase_inside" = yes ]; then
        return 1
      fi
    elif [ "$rgr_log_phase_inside" = yes ] && [ "$rgr_log_phase_record" = "$rgr_log_phase_name" ]; then
      printf '%s\n' "$rgr_log_phase_line_value"
      return
    fi
  done < "$rgr_log_phase_file"
  return 1
}
