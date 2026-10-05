import {DeleteIndexInLoop} from "../../src/rules/delete_index_in_loop";
import {testRule} from "./_utils";

const tests = [
  {abap: "parser error", cnt: 0},
  {abap: "WRITE hello.", cnt: 0},

  // the defect
  {abap: `LOOP AT tab INTO row.
  DELETE tab INDEX sy-tabix.
ENDLOOP.`, cnt: 1},
  {abap: `LOOP AT tab INTO row.
  IF row-flag = abap_true.
    DELETE tab INDEX sy-tabix.
  ENDIF.
ENDLOOP.`, cnt: 1},
  // …and the shape that is wrong twice over: sy-tabix belongs to the INNER
  // loop, so the index deleted is another table's
  {abap: `LOOP AT outer INTO row.
  LOOP AT inner INTO line.
    DELETE outer INDEX sy-tabix.
  ENDLOOP.
ENDLOOP.`, cnt: 1},

  // the standard read-then-delete, which is correct and common
  {abap: `READ TABLE tab INTO row WITH KEY id = 1.
DELETE tab INDEX sy-tabix.`, cnt: 0},
  {abap: `LOOP AT other INTO line.
  READ TABLE tab INTO row WITH KEY id = line-id.
  DELETE tab INDEX sy-tabix.
ENDLOOP.`, cnt: 0},

  // a DELETE on a table nobody is looping over
  {abap: `LOOP AT tab INTO row.
  DELETE other INDEX sy-tabix.
ENDLOOP.`, cnt: 0},
  // outside a loop entirely
  {abap: `DELETE tab INDEX sy-tabix.`, cnt: 0},
  // the right way to say it
  {abap: `DELETE tab WHERE flag = abap_true.`, cnt: 0},
  {abap: `LOOP AT tab INTO row.
  DELETE tab INDEX 1.
ENDLOOP.`, cnt: 0},
  // a closed loop before it is not an enclosing one
  {abap: `LOOP AT tab INTO row.
ENDLOOP.
DELETE tab INDEX sy-tabix.`, cnt: 0},
  // DELETE TABLE addresses by key, not by index
  {abap: `LOOP AT tab INTO row.
  DELETE TABLE tab FROM row.
ENDLOOP.`, cnt: 0},
];

testRule(tests, DeleteIndexInLoop);
