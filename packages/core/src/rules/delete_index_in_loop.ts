import * as Statements from "../abap/2_statements/statements";
import * as Expressions from "../abap/2_statements/expressions";
import {Issue} from "../issue";
import {BasicRuleConfig} from "./_basic_rule_config";
import {ABAPRule} from "./_abap_rule";
import {IRuleMetadata, RuleTag} from "./_irule";
import {StatementNode} from "../abap/nodes/statement_node";
import {Comment} from "../abap/2_statements/statements/_statement";
import {ABAPFile} from "../abap/abap_file";

export class DeleteIndexInLoopConf extends BasicRuleConfig {
}

export class DeleteIndexInLoop extends ABAPRule {
  private conf = new DeleteIndexInLoopConf();

  public getMetadata(): IRuleMetadata {
    return {
      key: "delete_index_in_loop",
      title: "DELETE INDEX sy-tabix inside a LOOP over the same table",
      shortDescription: `DELETE itab INDEX sy-tabix inside a LOOP AT that same table. The loop's own
cursor is what sy-tabix holds, so deleting by it shortens the table under the
walk: the following row is skipped, and the last round runs off the end.`,
      extendedInformation: `\`LOOP AT itab\` sets \`sy-tabix\` to the index of the row it is on, so
\`DELETE itab INDEX sy-tabix\` inside that loop deletes the row being visited
and shifts every later row down by one. The loop's cursor does not shift with
it: the next row is skipped, and on the last round the index is past the end,
which raises \`TABLE_INVALID_INDEX\` rather than doing nothing.

Build the result instead of mutating the table being walked:

\`\`\`abap
DATA keep LIKE tab.
LOOP AT tab INTO DATA(row).
  IF <keep it>.
    APPEND row TO keep.
  ENDIF.
ENDLOOP.
tab = keep.
\`\`\`

or say it in one statement with \`DELETE tab WHERE ...\` where the condition
fits there.

NOT reported: \`DELETE itab INDEX sy-tabix\` right after a \`READ TABLE itab\`,
which is the standard read-then-delete - there \`sy-tabix\` is the index that
read just set. That form is common and correct, and a rule that reported it
would be switched off within a week.`,
      tags: [RuleTag.SingleFile],
      badExample: `LOOP AT tab INTO row.
  IF row-flag = abap_true.
    DELETE tab INDEX sy-tabix.
  ENDIF.
ENDLOOP.`,
      goodExample: `DELETE tab WHERE flag = abap_true.`,
    };
  }

  public getConfig() {
    return this.conf;
  }

  public setConfig(conf: DeleteIndexInLoopConf) {
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
      if (this.afterReadOn(i, statements, deleted) === true) {
        continue;
      }
      if (this.enclosingLoops(i, statements).includes(deleted) === false) {
        continue;
      }

      const message = `DELETE ${deleted} INDEX sy-tabix inside LOOP AT ${deleted}`
        + ` - the loop's own cursor: the next row is skipped and the last round runs off the end`;
      issues.push(Issue.atStatement(file, statement, message, this.getMetadata().key, this.conf.severity));
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

  /** The standard read-then-delete: the nearest preceding statement that is
   *  not a comment is a READ TABLE on the SAME table, so sy-tabix is the one
   *  that read set. */
  private afterReadOn(index: number, statements: readonly StatementNode[], table: string): boolean {
    for (let i = index - 1; i >= 0; i--) {
      const statement = statements[i];
      if (statement.get() instanceof Comment) {
        continue;
      }
      if (!(statement.get() instanceof Statements.ReadTable)) {
        return false;
      }
      const read = statement.findDirectExpression(Expressions.Target)?.concatTokens().toUpperCase();
      return read === table;
    }
    return false;
  }

  /** The tables of every LOOP AT still open at this statement. */
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
