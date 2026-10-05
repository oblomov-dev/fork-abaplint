import * as Statements from "../abap/2_statements/statements";
import * as Expressions from "../abap/2_statements/expressions";
import {Issue} from "../issue";
import {BasicRuleConfig} from "./_basic_rule_config";
import {ABAPRule} from "./_abap_rule";
import {IRuleMetadata, RuleTag} from "./_irule";
import {StatementNode} from "../abap/nodes/statement_node";
import {Comment} from "../abap/2_statements/statements/_statement";
import {ABAPFile} from "../abap/abap_file";

export class DeleteIndexStaleTabixConf extends BasicRuleConfig {
}

export class DeleteIndexStaleTabix extends ABAPRule {
  private conf = new DeleteIndexStaleTabixConf();

  public getMetadata(): IRuleMetadata {
    return {
      key: "delete_index_stale_tabix",
      title: "DELETE INDEX sy-tabix with a sy-tabix of another table",
      shortDescription: `DELETE itab INDEX sy-tabix inside LOOP AT itab, where sy-tabix belongs to another
table: an inner LOOP over another table, or a READ TABLE on another table
before the DELETE.`,
      extendedInformation: `Inside \`LOOP AT itab\`, \`DELETE itab INDEX sy-tabix\` deletes the current row, and
the loop continues correctly with the next one. It goes wrong when \`sy-tabix\`
no longer belongs to \`itab\`:

* the \`DELETE\` sits inside an inner \`LOOP\` over another table, so \`sy-tabix\` is
  the inner loop's index,
* a \`READ TABLE\` on another table ran in the loop body before the \`DELETE\`, so
  \`sy-tabix\` is that read's index, or 0 when it found nothing.

Then another row is deleted, or index 0 ends in \`TABLE_INVALID_INDEX\`.

Not reported: an inner \`LOOP\` that has ended, a \`DO\` or a method call between
the \`LOOP\` and the \`DELETE\` - after them \`sy-tabix\` is the outer loop's again -
and a \`READ TABLE\` on the same table, the standard read-then-delete.`,
      tags: [RuleTag.SingleFile],
      badExample: `LOOP AT lt_items INTO ls_item.
  READ TABLE lt_blocked WITH KEY id = ls_item-id TRANSPORTING NO FIELDS.
  IF sy-subrc = 0.
    DELETE lt_items INDEX sy-tabix.
  ENDIF.
ENDLOOP.`,
      goodExample: `LOOP AT lt_items INTO ls_item.
  DATA(lv_tabix) = sy-tabix.
  READ TABLE lt_blocked WITH KEY id = ls_item-id TRANSPORTING NO FIELDS.
  IF sy-subrc = 0.
    DELETE lt_items INDEX lv_tabix.
  ENDIF.
ENDLOOP.`,
    };
  }

  public getConfig() {
    return this.conf;
  }

  public setConfig(conf: DeleteIndexStaleTabixConf) {
    this.conf = conf;
  }

  public runParsed(file: ABAPFile): Issue[] {
    const issues: Issue[] = [];
    const statements = file.getStatements();

    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i];
      if (!(statement.get() instanceof Statements.DeleteInternal)) {
        continue;
      }
      const deleted = this.deletedTable(statement);
      if (deleted === undefined || this.byTabix(statement) === false) {
        continue;
      }
      const loops = this.enclosingLoops(i, statements);
      if (loops.includes(deleted) === false) {
        continue;
      }

      let message: string | undefined = undefined;
      if (loops[0] !== deleted) {
        message = `DELETE ${deleted} INDEX sy-tabix inside LOOP AT ${loops[0]}, sy-tabix is the index of ${loops[0]}`;
      } else {
        const read = this.lastReadInLoop(i, statements);
        if (read !== undefined && read !== deleted) {
          message = `DELETE ${deleted} INDEX sy-tabix after READ TABLE ${read}, sy-tabix is the index of ${read}`;
        }
      }
      if (message !== undefined) {
        issues.push(Issue.atStatement(file, statement, message, this.getMetadata().key, this.conf.severity));
      }
    }

    return issues;
  }

////////////////

  private deletedTable(statement: StatementNode): string | undefined {
    const concat = statement.concatTokens().toUpperCase();
    // `DELETE TABLE itab ...` addresses by key, not by index
    if (concat.startsWith("DELETE TABLE ") || concat.startsWith("DELETE ADJACENT ")) {
      return undefined;
    }
    return statement.findDirectExpression(Expressions.Target)?.concatTokens().toUpperCase();
  }

  private byTabix(statement: StatementNode): boolean {
    return statement.concatTokens().toUpperCase().includes("INDEX SY-TABIX");
  }

  /** The table of the nearest READ TABLE between the innermost open LOOP and
   *  the statement at index, outside nested loops, which restore sy-tabix when
   *  they end. Undefined when there is none. */
  private lastReadInLoop(index: number, statements: readonly StatementNode[]): string | undefined {
    let depth = 0;
    for (let i = index - 1; i >= 0; i--) {
      const statement = statements[i];
      const s = statement.get();
      if (s instanceof Comment) {
        continue;
      } else if (s instanceof Statements.EndLoop) {
        depth++;
      } else if (s instanceof Statements.Loop) {
        if (depth === 0) {
          return undefined;
        }
        depth--;
      } else if (depth === 0 && s instanceof Statements.ReadTable) {
        return statement.findDirectExpression(Expressions.SimpleSource2)?.concatTokens().toUpperCase()
          ?? statement.findFirstExpression(Expressions.Source)?.concatTokens().toUpperCase();
      }
    }
    return undefined;
  }

  /** The tables of every LOOP AT still open at this statement, innermost first. */
  private enclosingLoops(index: number, statements: readonly StatementNode[]): string[] {
    const open: string[] = [];
    let depth = 0;
    for (let i = index - 1; i >= 0; i--) {
      const statement = statements[i];
      const s = statement.get();
      if (s instanceof Statements.EndLoop) {
        depth++;
      } else if (s instanceof Statements.Loop) {
        if (depth === 0) {
          const table = statement.findFirstExpression(Expressions.SimpleSource2)?.concatTokens().toUpperCase()
            ?? statement.findFirstExpression(Expressions.Source)?.concatTokens().toUpperCase();
          if (table !== undefined) {
            open.push(table);
          }
        } else {
          depth--;
        }
      } else if (s instanceof Statements.MethodImplementation
          || s instanceof Statements.Form
          || s instanceof Statements.EndMethod
          || s instanceof Statements.EndForm) {
        break;
      }
    }
    return open;
  }

}
