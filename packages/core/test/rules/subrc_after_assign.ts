import {SubrcAfterAssign} from "../../src/rules/subrc_after_assign";
import {testRule, testRuleFix} from "./_utils";

const tests = [
  {abap: "parser error", cnt: 0},
  {abap: "WRITE hello.", cnt: 0},

  // the defect: a static ASSIGN does not set sy-subrc
  {abap: `ASSIGN lv_value TO <attri>.
IF sy-subrc = 0.
ENDIF.`, cnt: 1},
  {abap: `ASSIGN me->mv_attr TO <attri>.
IF sy-subrc <> 0.
  RETURN.
ENDIF.`, cnt: 1},
  {abap: `ASSIGN lv_text+1(2) TO <attri>.
ASSERT sy-subrc = 0.`, cnt: 1},
  // …also inside a compound condition
  {abap: `ASSIGN lv_value TO <attri>.
IF sy-subrc = 0 AND <attri> = abap_true.
ENDIF.`, cnt: 1},
  // the static branch of an IF, checked once after ENDIF
  {abap: `IF lv_path IS INITIAL.
  ASSIGN mo_app TO <attri>.
ELSE.
  ASSIGN (lv_path) TO <attri>.
ENDIF.
IF sy-subrc <> 0.
  RETURN.
ENDIF.`, cnt: 1},
  // …and of a CASE
  {abap: `CASE lv_kind.
  WHEN 'A'.
    ASSIGN mo_app TO <attri>.
  WHEN OTHERS.
    ASSIGN (lv_path) TO <attri>.
ENDCASE.
IF sy-subrc <> 0.
  RETURN.
ENDIF.`, cnt: 1},

  // the dynamic forms set sy-subrc, the check is right there
  {abap: `ASSIGN (lv_name) TO <attri>.
IF sy-subrc = 0.
ENDIF.`, cnt: 0},
  {abap: `ASSIGN lr_data->* TO <attri>.
IF sy-subrc <> 0.
  RETURN.
ENDIF.`, cnt: 0},
  {abap: `ASSIGN lt_tab[ 1 ] TO <attri>.
IF sy-subrc = 0.
ENDIF.`, cnt: 0},
  {abap: `ASSIGN COMPONENT lv_name OF STRUCTURE ls_data TO <attri>.
IF sy-subrc = 0.
ENDIF.`, cnt: 0},
  {abap: `ASSIGN COMPONENT 1 OF STRUCTURE ls_data TO <attri>.
IF sy-subrc <> 0.
  RETURN.
ENDIF.`, cnt: 0},
  {abap: `ASSIGN lo_obj->(lv_name) TO <attri>.
IF sy-subrc = 0.
ENDIF.`, cnt: 0},

  // the correct check, and the whole point of the rule
  {abap: `ASSIGN lv_value TO <attri>.
IF <attri> IS ASSIGNED.
ENDIF.`, cnt: 0},
  {abap: `ASSIGN lv_value TO <attri>.
IF <attri> IS NOT ASSIGNED.
  RETURN.
ENDIF.`, cnt: 0},

  // a sy-subrc belonging to something else
  {abap: `READ TABLE tab INTO row INDEX 1.
IF sy-subrc = 0.
ENDIF.`, cnt: 0},
  {abap: `ASSIGN lv_value TO <attri>.
WRITE 'hello'.
IF sy-subrc = 0.
ENDIF.`, cnt: 0},
  // an ASSIGN nobody checks at all is not this rule's business
  {abap: `ASSIGN lv_value TO <attri>.
WRITE 'hello'.`, cnt: 0},

  // still reported inside a loop - the read is wrong there too - and the
  // message names the UNASSIGN the fix needs
  {abap: `LOOP AT tab INTO row.
  ASSIGN lv_value TO <attri>.
  IF sy-subrc = 0.
  ENDIF.
ENDLOOP.`, cnt: 1},
  // …and when the same symbol was already assigned earlier in the block
  {abap: `ASSIGN lv_first TO <attri>.
IF <attri> IS ASSIGNED.
ENDIF.
ASSIGN lv_second TO <attri>.
IF sy-subrc = 0.
ENDIF.`, cnt: 1},
];

testRule(tests, SubrcAfterAssign);

const fixes = [
  {
    input: `ASSIGN lv_value TO <attri>.
IF sy-subrc = 0.
ENDIF.`,
    output: `ASSIGN lv_value TO <attri>.
IF <attri> IS ASSIGNED.
ENDIF.`,
  },
  {
    input: `ASSIGN lv_value TO <attri>.
IF sy-subrc <> 0.
  RETURN.
ENDIF.`,
    output: `ASSIGN lv_value TO <attri>.
IF <attri> IS NOT ASSIGNED.
  RETURN.
ENDIF.`,
  },
  {
    // the comparison is rewritten in place, so a compound condition survives
    input: `ASSIGN lv_value TO <attri>.
IF sy-subrc = 0 AND lv_flag = abap_true.
ENDIF.`,
    output: `ASSIGN lv_value TO <attri>.
IF <attri> IS ASSIGNED AND lv_flag = abap_true.
ENDIF.`,
  },
  {
    input: `ASSIGN lv_value TO <attri>.
ASSERT sy-subrc = 0.`,
    output: `ASSIGN lv_value TO <attri>.
ASSERT <attri> IS ASSIGNED.`,
  },
  {
    // the static branch of an IF, fixed at the shared check
    input: `IF lv_path IS INITIAL.
  ASSIGN mo_app TO <attri>.
ELSE.
  ASSIGN (lv_path) TO <attri>.
ENDIF.
IF sy-subrc <> 0.
  RETURN.
ENDIF.`,
    output: `IF lv_path IS INITIAL.
  ASSIGN mo_app TO <attri>.
ELSE.
  ASSIGN (lv_path) TO <attri>.
ENDIF.
IF <attri> IS NOT ASSIGNED.
  RETURN.
ENDIF.`,
  },
];

testRuleFix(fixes, SubrcAfterAssign);
