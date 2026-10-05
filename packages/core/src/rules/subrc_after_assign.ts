import * as Statements from "../abap/2_statements/statements";
import * as Expressions from "../abap/2_statements/expressions";
import {Issue} from "../issue";
import {BasicRuleConfig} from "./_basic_rule_config";
import {ABAPRule} from "./_abap_rule";
import {IRuleMetadata, RuleTag} from "./_irule";
import {StatementNode} from "../abap/nodes/statement_node";
import {Comment} from "../abap/2_statements/statements/_statement";
import {ABAPFile} from "../abap/abap_file";
import {EditHelper, IEdit} from "../edit_helper";
import {AbstractToken} from "../abap/1_lexer/tokens/abstract_token";

export class SubrcAfterAssignConf extends BasicRuleConfig {
  /** Also report the shapes where `IS ASSIGNED` is not a drop-in replacement:
   * the ASSIGN sits inside a loop, or the same field symbol was already
   * assigned earlier in the same block. The finding is correct there too -
   * the sy-subrc read is wrong either way - but the remedy needs an
   * `UNASSIGN` first, so no quick fix is offered for them. */
  public loops: boolean = true;
}

export class SubrcAfterAssign extends ABAPRule {
  private conf = new SubrcAfterAssignConf();

  public getMetadata(): IRuleMetadata {
    return {
      key: "subrc_after_assign",
      title: "sy-subrc is not set by a static ASSIGN",
      shortDescription: `A sy-subrc test whose nearest preceding sy-subrc-setting statement is a static
ASSIGN. A static ASSIGN does not set sy-subrc, so the test reads a value an
earlier statement left behind.`,
      extendedInformation: `Only the dynamic forms of \`ASSIGN\` set \`sy-subrc\`: a dynamic name \`(name)\`,
\`dref->*\`, a table expression and \`ASSIGN COMPONENT\`. A static \`ASSIGN dobj TO <fs>\`
- a variable, an attribute, an object reference, an offset/length - leaves it
untouched, so a test right after it reads whatever the last statement that DOES
set it left there. Measured on 7.58: after a failed \`READ TABLE\`, a successful
static \`ASSIGN\` leaves \`sy-subrc = 4\`, the four dynamic forms set 0.

The typical shape is a static and a dynamic \`ASSIGN\` in two branches of an \`IF\`,
followed by one \`sy-subrc\` check. The dynamic branch is fine, the static one
is not, and the transpiled runtime sets \`sy-subrc\` in both, so no unit test sees
it.

\`IS [NOT] ASSIGNED\` asks the question directly and has no such gap.

It is NOT always a drop-in replacement. A FAILED \`ASSIGN\` leaves the field
symbol bound to whatever it pointed at before, so wherever the same symbol can
already be bound - inside a loop, or after an earlier \`ASSIGN\` to it -
\`IS ASSIGNED\` reads TRUE for a failure. Those sites need \`UNASSIGN <fs>.\`
before the \`ASSIGN\`, and the rule says so in the message rather than offering
a quick fix that would introduce the bug it is meant to remove.`,
      tags: [RuleTag.SingleFile, RuleTag.Quickfix],
      badExample: `IF lv_path IS INITIAL.
  ASSIGN mo_app TO <attri>.
ELSE.
  ASSIGN (lv_path) TO <attri>.
ENDIF.
IF sy-subrc <> 0.
  RETURN.
ENDIF.`,
      goodExample: `IF lv_path IS INITIAL.
  ASSIGN mo_app TO <attri>.
ELSE.
  ASSIGN (lv_path) TO <attri>.
ENDIF.
IF <attri> IS NOT ASSIGNED.
  RETURN.
ENDIF.`,
    };
  }

  public getConfig() {
    return this.conf;
  }

  public setConfig(conf: SubrcAfterAssignConf) {
    this.conf = conf;
  }

  public runParsed(file: ABAPFile): Issue[] {
    const issues: Issue[] = [];
    const statements = file.getStatements();

    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i];
      if (!(statement.get() instanceof Statements.Assign)) {
        continue;
      }
      if (this.isStatic(statement) === false) {
        continue;
      }

      const fs = statement.findFirstExpression(Expressions.FSTarget)
        ?.findFirstExpression(Expressions.FieldSymbol)?.getFirstToken().getStr();
      if (fs === undefined) {
        continue;
      }

      const check = this.nextStatementReadingSubrc(i, statements);
      if (check === undefined) {
        continue;
      }

      const reassigned = this.assignedEarlier(i, statements, fs);
      const inLoop = this.insideLoop(i, statements);
      if ((reassigned === true || inLoop === true) && this.conf.loops === false) {
        continue;
      }

      let fix: IEdit | undefined = undefined;
      let message = `A static ASSIGN does not set sy-subrc, use "${fs} IS ASSIGNED"`;
      if (reassigned === true || inLoop === true) {
        // the naive rewrite would read TRUE for a FAILED assign here, because
        // the symbol can still be bound from before
        message += `, with UNASSIGN ${fs} before the ASSIGN - `
          + (inLoop === true ? `it is inside a loop` : `${fs} is assigned earlier in this block`);
      } else {
        fix = this.buildFix(file, check, fs);
      }

      issues.push(Issue.atStatement(file, check, message, this.getMetadata().key, this.conf.severity, fix));
    }

    return issues;
  }

////////////////

  /** Only the static form leaves sy-subrc untouched. A dynamic name, a
   *  dereference, a table expression, COMPONENT, TABLE FIELD and INCREMENT all
   *  set it, as does anything with a dynamic part, so they are not reported. */
  private isStatic(statement: StatementNode): boolean {
    const source = statement.findDirectExpression(Expressions.AssignSource);
    if (source === undefined
        || statement.findFirstExpression(Expressions.Dynamic) !== undefined
        || source.findFirstExpression(Expressions.TableExpression) !== undefined) {
      return false;
    }
    const concat = source.concatTokens().toUpperCase();
    const statementConcat = statement.concatTokens().toUpperCase();
    return concat.startsWith("COMPONENT ") === false
      && concat.startsWith("TABLE FIELD ") === false
      && concat.includes("->*") === false
      && statementConcat.includes(" INCREMENT ") === false
      && statementConcat.includes(" ELSE UNASSIGN") === false;
  }

  /** The next statement that actually looks at sy-subrc, or undefined when the
   *  next one that matters does something else. Comments and ENDIF are skipped
   *  the way check_subrc skips them, and from an ELSE, ELSEIF or WHEN the path
   *  continues after the block; an `IS [NOT] ASSIGNED` on the same symbol is
   *  the correct check and ends the search. */
  private nextStatementReadingSubrc(index: number, statements: readonly StatementNode[]): StatementNode | undefined {
    const fs = statements[index].findFirstExpression(Expressions.FSTarget)
      ?.findFirstExpression(Expressions.FieldSymbol)?.getFirstToken().getStr().toUpperCase();

    for (let i = index + 1; i < statements.length; i++) {
      const statement = statements[i];
      const concat = statement.concatTokens().toUpperCase();
      if (statement.get() instanceof Comment) {
        continue;
      } else if (statement.get() instanceof Statements.EndIf
          || statement.get() instanceof Statements.EndCase
          || statement.get() instanceof Statements.EndTestSeam) {
        continue;
      } else if (statement.get() instanceof Statements.Else
          || statement.get() instanceof Statements.ElseIf
          || statement.get() instanceof Statements.When
          || statement.get() instanceof Statements.WhenOthers) {
        // the other branches are not on this path, it continues after the block
        i = this.endOfBlock(i, statements);
        continue;
      }
      if (fs !== undefined
          && (concat.includes(fs + " IS ASSIGNED") || concat.includes(fs + " IS NOT ASSIGNED"))) {
        return undefined;
      }
      if (concat.includes("SY-SUBRC")) {
        return statement;
      }
      return undefined;
    }
    return undefined;
  }

  /** The ENDIF or ENDCASE that closes the block the branch at index belongs to */
  private endOfBlock(index: number, statements: readonly StatementNode[]): number {
    let depth = 0;
    for (let i = index + 1; i < statements.length; i++) {
      const s = statements[i].get();
      if (s instanceof Statements.If || s instanceof Statements.Case) {
        depth++;
      } else if (s instanceof Statements.EndIf || s instanceof Statements.EndCase) {
        if (depth === 0) {
          return i;
        }
        depth--;
      }
    }
    return statements.length;
  }

  /** Is the ASSIGN inside a LOOP / DO / WHILE of the same block? Counted by
   *  walking back for an unclosed loop opener. */
  private insideLoop(index: number, statements: readonly StatementNode[]): boolean {
    let depth = 0;
    for (let i = index - 1; i >= 0; i--) {
      const s = statements[i].get();
      if (s instanceof Statements.EndLoop || s instanceof Statements.EndDo || s instanceof Statements.EndWhile) {
        depth++;
      } else if (s instanceof Statements.Loop || s instanceof Statements.Do || s instanceof Statements.While) {
        if (depth === 0) {
          return true;
        }
        depth--;
      } else if (this.startsBlock(statements[i])) {
        return false;
      }
    }
    return false;
  }

  /** Was the same field symbol already the target of an ASSIGN or READ TABLE
   *  earlier in this block? Then a failed ASSIGN leaves it bound. */
  private assignedEarlier(index: number, statements: readonly StatementNode[], fs: string): boolean {
    const upper = fs.toUpperCase();
    for (let i = index - 1; i >= 0; i--) {
      const statement = statements[i];
      if (this.startsBlock(statement)) {
        return false;
      }
      const s = statement.get();
      if (s instanceof Statements.Assign || s instanceof Statements.ReadTable || s instanceof Statements.Loop) {
        const target = statement.findFirstExpression(Expressions.FSTarget)
          ?.findFirstExpression(Expressions.FieldSymbol)?.getFirstToken().getStr().toUpperCase();
        if (target === upper) {
          return true;
        }
      }
    }
    return false;
  }

  private startsBlock(statement: StatementNode): boolean {
    const s = statement.get();
    return s instanceof Statements.MethodImplementation
      || s instanceof Statements.Form
      || s instanceof Statements.FunctionModule
      || s instanceof Statements.EndMethod
      || s instanceof Statements.EndForm;
  }

  /** Rewrite the `sy-subrc = 0` / `sy-subrc <> 0` comparison in place, which
   *  works inside a compound condition too. Anything else - a comparison to
   *  another value, a CASE, an operator this does not know - gets no fix. */
  private buildFix(file: ABAPFile, statement: StatementNode, fs: string): IEdit | undefined {
    // `sy-subrc` is THREE tokens - `sy`, `-`, `subrc` - so the comparison to
    // rewrite is five, and the fix spans from the first to the last of them
    const tokens = statement.getTokens();
    for (let i = 0; i + 4 < tokens.length; i++) {
      if (tokens[i].getStr().toUpperCase() !== "SY"
          || tokens[i + 1].getStr() !== "-"
          || tokens[i + 2].getStr().toUpperCase() !== "SUBRC") {
        continue;
      }
      const op = tokens[i + 3].getStr().toUpperCase();
      if (tokens[i + 4].getStr() !== "0") {
        return undefined;
      }
      let text: string | undefined = undefined;
      if (op === "=" || op === "EQ") {
        text = `${fs} IS ASSIGNED`;
      } else if (op === "<>" || op === "NE") {
        text = `${fs} IS NOT ASSIGNED`;
      }
      if (text === undefined) {
        return undefined;
      }
      return EditHelper.replaceRange(file, tokens[i].getStart(), this.endOf(tokens[i + 4]), text);
    }
    return undefined;
  }

  private endOf(token: AbstractToken) {
    return token.getEnd();
  }

}
