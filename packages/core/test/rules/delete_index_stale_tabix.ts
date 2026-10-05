import {DeleteIndexStaleTabix} from "../../src/rules/delete_index_stale_tabix";
import {testRule} from "./_utils";

const tests = [
  {abap: "parser error", cnt: 0},
  {abap: "WRITE hello.", cnt: 0},

  // sy-tabix belongs to an inner loop over another table
  {abap: `LOOP AT outer INTO row.
  LOOP AT inner INTO line.
    DELETE outer INDEX sy-tabix.
  ENDLOOP.
ENDLOOP.`, cnt: 1},
  // sy-tabix was set by a READ TABLE on another table
  {abap: `LOOP AT tab INTO row.
  READ TABLE other WITH KEY id = row-id TRANSPORTING NO FIELDS.
  IF sy-subrc = 0.
    DELETE tab INDEX sy-tabix.
  ENDIF.
ENDLOOP.`, cnt: 1},
  {abap: `LOOP AT tab INTO row.
  READ TABLE other INTO line INDEX 1.
  DELETE tab INDEX sy-tabix.
ENDLOOP.`, cnt: 1},

  // the current row of its own loop: the loop continues correctly
  {abap: `LOOP AT tab INTO row.
  DELETE tab INDEX sy-tabix.
ENDLOOP.`, cnt: 0},
  {abap: `LOOP AT tab INTO row.
  IF row-flag = abap_true.
    DELETE tab INDEX sy-tabix.
  ENDIF.
ENDLOOP.`, cnt: 0},
  // an inner loop that has ended restores sy-tabix
  {abap: `LOOP AT tab INTO row.
  LOOP AT other INTO line.
  ENDLOOP.
  DELETE tab INDEX sy-tabix.
ENDLOOP.`, cnt: 0},
  // …also when it read another table inside
  {abap: `LOOP AT tab INTO row.
  LOOP AT other INTO line.
    READ TABLE third INTO entry INDEX 1.
  ENDLOOP.
  DELETE tab INDEX sy-tabix.
ENDLOOP.`, cnt: 0},
  // DO and method calls do not change it
  {abap: `LOOP AT tab INTO row.
  DO 3 TIMES.
  ENDDO.
  lo_obj->run( ).
  DELETE tab INDEX sy-tabix.
ENDLOOP.`, cnt: 0},
  // the standard read-then-delete on the same table
  {abap: `READ TABLE tab INTO row WITH KEY id = 1.
DELETE tab INDEX sy-tabix.`, cnt: 0},
  {abap: `LOOP AT tab INTO row.
  READ TABLE tab INTO row2 WITH KEY id = row-id.
  DELETE tab INDEX sy-tabix.
ENDLOOP.`, cnt: 0},
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
  {abap: `DELETE tab WHERE flag = abap_true.`, cnt: 0},
  // a saved index
  {abap: `LOOP AT tab INTO row.
  lv_tabix = sy-tabix.
  READ TABLE other WITH KEY id = row-id TRANSPORTING NO FIELDS.
  DELETE tab INDEX lv_tabix.
ENDLOOP.`, cnt: 0},
  // DELETE TABLE addresses by key, not by index
  {abap: `LOOP AT tab INTO row.
  DELETE TABLE tab FROM row.
ENDLOOP.`, cnt: 0},
];

testRule(tests, DeleteIndexStaleTabix);
