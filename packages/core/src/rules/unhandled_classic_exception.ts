import * as Statements from "../abap/2_statements/statements";
import * as Expressions from "../abap/2_statements/expressions";
import {Issue} from "../issue";
import {ABAPRule} from "./_abap_rule";
import {BasicRuleConfig} from "./_basic_rule_config";
import {Severity} from "../severity";
import {IRuleMetadata, RuleTag} from "./_irule";
import {ABAPFile} from "../abap/abap_file";
import {ABAPObject} from "../objects/_abap_object";
import {IRegistry} from "../_iregistry";
import {FunctionGroup} from "../objects";
import {SyntaxLogic} from "../abap/5_syntax/syntax";
import {ISpaghettiScopeNode} from "../abap/5_syntax/_spaghetti_scope";
import {ReferenceType} from "../abap/5_syntax/_reference";
import {MethodDefinition} from "../abap/types";
import {FunctionModuleDefinition} from "../abap/types/function_module_definition";
import {ExpressionNode, StatementNode, TokenNode} from "../abap/nodes";
import {AbstractToken} from "../abap/1_lexer/tokens/abstract_token";
import {Position} from "../position";
import {VirtualPosition} from "../virtual_position";

export class UnhandledClassicExceptionConf extends BasicRuleConfig {
  public severity?: Severity = Severity.Warning;
  /** Report an EXCEPTIONS list without OTHERS, unless the method or function module is known and all its exceptions are listed */
  public missingOthers: boolean = true;
  /** Report a call without EXCEPTIONS, including a functional call, of a method or function module that declares classic exceptions */
  public missingExceptions: boolean = true;
  /** missingExceptions: do not report a method call whose arguments are all literals or me, like describe_by_name( 'T100' ) */
  public allowLiteralArguments: boolean = true;
  /** Report CALL FUNCTION without error_message, when the function module is known and can send a message of type E or A without RAISING */
  public missingErrorMessage: boolean = true;
  /** missingErrorMessage: also report calls of function modules that are not found (void) or called by a dynamic name */
  public errorMessageVoid: boolean = false;
}

interface ICallee {
  name: string;
  exceptions: string[];
}

interface IKnownModule {
  definition: FunctionModuleDefinition;
  group: FunctionGroup;
}

interface ISentMessage {
  /** E, A, or undefined for a message type that is not a literal */
  type: string | undefined;
  /** the function module or form that sends it, when it is not the called function module itself */
  via: string | undefined;
}

export class UnhandledClassicException extends ABAPRule {
  private conf = new UnhandledClassicExceptionConf();
  private functionModules: Map<string, IKnownModule> | undefined;
  private sentMessages = new Map<string, ISentMessage | undefined>();

  public getMetadata(): IRuleMetadata {
    return {
      key: "unhandled_classic_exception",
      title: "Unhandled classic exception",
      shortDescription: `Finds calls that do not map every classic exception the callee can raise`,
      extendedInformation: `A classic exception that is raised with RAISE and not mapped in the EXCEPTIONS addition of the call
ends in the runtime error RAISE_EXCEPTION. TRY ... CATCH cx_root does not catch it.

missingOthers: reports CALL FUNCTION and method calls with an EXCEPTIONS list without OTHERS.
Not reported if the function module or method is known and every exception it declares is listed,
for CALL FUNCTION ... DESTINATION this includes SYSTEM_FAILURE and COMMUNICATION_FAILURE.
CALL FUNCTION ... STARTING NEW TASK, IN UPDATE TASK and IN BACKGROUND are not checked.

missingExceptions: reports calls without EXCEPTIONS of a method or function module that declares classic exceptions,
this includes functional calls, which cannot have EXCEPTIONS.
With allowLiteralArguments, a method call whose arguments are all literals or me is not reported.

missingErrorMessage: reports CALL FUNCTION without the predefined exception error_message, when the function module
can send a message of type E or A without RAISING. OTHERS does not catch such a message, in dialog it is shown,
in background, RFC and HTTP processing it ends the processing. The function module source is searched,
including forms of its function group and function modules it calls. With errorMessageVoid, calls of function
modules that are not found, or are called by a dynamic name, are also reported.
CALL FUNCTION ... DESTINATION, STARTING NEW TASK, IN UPDATE TASK and IN BACKGROUND are not checked.

Signatures are taken from the registry, including dependencies. Methods and function modules that are not
found (void) are only checked by missingOthers and errorMessageVoid.

Does not report any issues if the code contains syntax errors`,
      tags: [RuleTag.Syntax],
      badExample: `CALL FUNCTION 'Z_READ'
  EXCEPTIONS
    not_found = 1.

lo_type = cl_abap_typedescr=>describe_by_name( lv_name ).`,
      goodExample: `CALL FUNCTION 'Z_READ'
  EXCEPTIONS
    not_found = 1
    OTHERS    = 2.

cl_abap_typedescr=>describe_by_name(
  EXPORTING
    p_name         = lv_name
  RECEIVING
    p_descr_ref    = lo_type
  EXCEPTIONS
    type_not_found = 1
    OTHERS         = 2 ).`,
    };
  }

  public initialize(reg: IRegistry) {
    super.initialize(reg);
    this.functionModules = undefined;
    this.sentMessages = new Map<string, ISentMessage | undefined>();
    return this;
  }

  public getConfig() {
    return this.conf;
  }

  public setConfig(conf: UnhandledClassicExceptionConf) {
    this.conf = conf;
  }

  public runParsed(file: ABAPFile, obj: ABAPObject): Issue[] {
    if (obj.getType() === "INTF" || file.getStructure() === undefined) {
      return [];
    }

    const syntax = new SyntaxLogic(this.reg, obj).run();
    if (syntax.issues.length > 0) {
      return [];
    }

    const methods = new Map<string, MethodDefinition>();
    this.findMethodReferences(syntax.spaghetti.getTop(), file.getFilename(), methods);

    const issues: Issue[] = [];
    for (const statement of file.getStatements()) {
      if (statement.get() instanceof Statements.CallFunction) {
        issues.push(...this.checkCallFunction(statement, file));
        continue;
      }

      if (statement.get() instanceof Statements.Call) {
        const source = statement.findDirectExpression(Expressions.MethodSource);
        const body = statement.findDirectExpression(Expressions.MethodCallBody);
        const nameNode = source?.getLastChild();
        if (nameNode) {
          const token = nameNode.getFirstToken();
          const callee = nameNode.get() instanceof Expressions.Dynamic ? undefined : this.findMethod(methods, token);
          const issue = this.checkCall(file, token, callee, body?.findDirectExpression(Expressions.MethodParameters),
                                       body?.findDirectTokenByText("EXCEPTION-TABLE") !== undefined, false, this.onlyLiterals(body));
          if (issue) {
            issues.push(issue);
          }
        }
      }

      for (const call of statement.findAllExpressionsRecursive(Expressions.MethodCall)) {
        const token = call.findDirectExpression(Expressions.MethodName)?.getFirstToken();
        if (token === undefined) {
          continue;
        }
        const param = call.findDirectExpression(Expressions.MethodCallParam);
        const parameters = param?.findDirectExpression(Expressions.MethodParameters);
        const issue = this.checkCall(file, token, this.findMethod(methods, token), parameters, false, false, this.onlyLiterals(param));
        if (issue) {
          issues.push(issue);
        }
      }
    }

    return issues;
  }

  private checkCallFunction(statement: StatementNode, file: ABAPFile): Issue[] {
    if (statement.findDirectTokenByText("STARTING")
        || statement.findDirectTokenByText("UPDATE")
        || statement.findDirectTokenByText("BACKGROUND")) {
      return [];
    }

    const nameNode = statement.findDirectExpression(Expressions.FunctionName);
    if (nameNode === undefined) {
      return [];
    }

    let callee: ICallee | undefined = undefined;
    if (nameNode.findFirstExpression(Expressions.FieldChain) === undefined) {
      const module = this.findFunctionModule(UnhandledClassicException.functionName(nameNode))?.definition;
      if (module) {
        callee = {
          name: module.getName(),
          exceptions: module.isClassBasedExceptions() ? [] : module.getExceptions().map(e => e.toUpperCase()),
        };
      }
    }

    const issues: Issue[] = [];
    const issue = this.checkCall(file, nameNode.getFirstToken(), callee, statement.findDirectExpression(Expressions.FunctionParameters),
                                 statement.findDirectTokenByText("EXCEPTION-TABLE") !== undefined,
                                 statement.findDirectExpression(Expressions.Destination) !== undefined, false);
    if (issue) {
      issues.push(issue);
    }

    const errorMessage = this.checkErrorMessage(statement, nameNode, file);
    if (errorMessage) {
      issues.push(errorMessage);
    }
    return issues;
  }

  private checkErrorMessage(statement: StatementNode, nameNode: ExpressionNode, file: ABAPFile): Issue | undefined {
    if (this.conf.missingErrorMessage === false
        || statement.findDirectExpression(Expressions.Destination) !== undefined
        || statement.findDirectTokenByText("EXCEPTION-TABLE") !== undefined
        || UnhandledClassicException.listsErrorMessage(statement)) {
      return undefined;
    }

    const parameters = statement.findDirectExpression(Expressions.FunctionParameters);
    const position = parameters?.findDirectTokenByText("EXCEPTIONS") || nameNode.getFirstToken();

    const module = nameNode.findFirstExpression(Expressions.FieldChain) === undefined
      ? this.findFunctionModule(UnhandledClassicException.functionName(nameNode))
      : undefined;
    if (module === undefined) {
      if (this.conf.errorMessageVoid === false) {
        return undefined;
      }
      const message = "No error_message, OTHERS does not catch a message that the function module sends without RAISING";
      return Issue.atToken(file, position, message, this.getMetadata().key, this.conf.severity);
    }

    if (module.definition.isClassBasedExceptions()) {
      return undefined;
    }

    const sent = this.findSentMessage(module.definition.getName().toUpperCase());
    if (sent === undefined) {
      return undefined;
    }
    const what = sent.type === undefined ? "a message with a dynamic type" : "a message of type " + sent.type;
    const via = sent.via === undefined ? "" : ` via "${sent.via}"`;
    const message = `"${module.definition.getName().toUpperCase()}" can send ${what}${via}, ` +
      "add error_message to EXCEPTIONS, OTHERS does not catch it";
    return Issue.atToken(file, position, message, this.getMetadata().key, this.conf.severity);
  }

  /** finds a MESSAGE of type E or A without RAISING in the function module, its forms and the function modules it calls */
  private findSentMessage(moduleName: string): ISentMessage | undefined {
    const key = "FUNCTION " + moduleName;
    if (this.sentMessages.has(key)) {
      return this.sentMessages.get(key);
    }
    this.sentMessages.set(key, undefined); // recursion guard

    const module = this.findFunctionModule(moduleName);
    const statements = module ? UnhandledClassicException.findBlock(module.group, Statements.FunctionModule, moduleName) : undefined;
    const found = module && statements ? this.searchStatements(statements, module.group) : undefined;
    this.sentMessages.set(key, found);
    return found;
  }

  private findSentMessageInForm(group: FunctionGroup, formName: string): ISentMessage | undefined {
    const key = "FORM " + group.getName() + " " + formName;
    if (this.sentMessages.has(key)) {
      return this.sentMessages.get(key);
    }
    this.sentMessages.set(key, undefined); // recursion guard

    const statements = UnhandledClassicException.findBlock(group, Statements.Form, formName);
    const found = statements ? this.searchStatements(statements, group) : undefined;
    this.sentMessages.set(key, found);
    return found;
  }

  private searchStatements(statements: readonly StatementNode[], group: FunctionGroup): ISentMessage | undefined {
    for (const s of statements) {
      const type = s.get();
      if (type instanceof Statements.Message) {
        if (s.findDirectTokenByText("RAISING") || s.findDirectTokenByText("INTO")) {
          continue;
        }
        const messageType = UnhandledClassicException.messageType(s);
        if (messageType === undefined || messageType === "E" || messageType === "A") {
          return {type: messageType, via: undefined};
        }
      } else if (type instanceof Statements.CallFunction) {
        const name = s.findDirectExpression(Expressions.FunctionName);
        if (name === undefined
            || name.findFirstExpression(Expressions.FieldChain) !== undefined
            || s.findDirectExpression(Expressions.Destination)
            || s.findDirectTokenByText("STARTING")
            || s.findDirectTokenByText("UPDATE")
            || s.findDirectTokenByText("BACKGROUND")
            || s.findDirectTokenByText("EXCEPTION-TABLE")
            || UnhandledClassicException.listsErrorMessage(s)) {
          continue;
        }
        const called = UnhandledClassicException.functionName(name);
        const found = this.findSentMessage(called);
        if (found) {
          return {type: found.type, via: found.via ?? called};
        }
      } else if (type instanceof Statements.Perform) {
        const form = s.findDirectExpression(Expressions.FormName);
        if (form === undefined
            || s.findDirectTokenByText("PROGRAM")
            || s.findDirectTokenByText("ON")
            || s.findDirectExpression(Expressions.IncludeName)) {
          continue;
        }
        const name = form.concatTokens().toUpperCase();
        const found = this.findSentMessageInForm(group, name);
        if (found) {
          return {type: found.type, via: found.via ?? name};
        }
      }
    }
    return undefined;
  }

  /** the statements between FUNCTION name and ENDFUNCTION, or FORM name and ENDFORM */
  private static findBlock(group: FunctionGroup, start: typeof Statements.FunctionModule | typeof Statements.Form,
                           name: string): StatementNode[] | undefined {
    for (const file of group.getABAPFiles()) {
      let block: StatementNode[] | undefined = undefined;
      for (const s of file.getStatements()) {
        if (block === undefined) {
          const blockName = s.findDirectExpression(Expressions.Field) ?? s.findDirectExpression(Expressions.FormName);
          if (s.get() instanceof start && blockName?.concatTokens().toUpperCase() === name) {
            block = [];
          }
        } else if (s.get() instanceof Statements.EndFunction || s.get() instanceof Statements.EndForm) {
          return block;
        } else {
          block.push(s);
        }
      }
    }
    return undefined;
  }

  /** E, A, I, S, W or X, undefined if the type is not a literal */
  private static messageType(statement: StatementNode): string | undefined {
    const source = statement.findDirectExpression(Expressions.MessageSource);
    const typeAndNumber = source?.findDirectExpression(Expressions.MessageTypeAndNumber);
    if (typeAndNumber) {
      return typeAndNumber.concatTokens().substring(0, 1).toUpperCase();
    }

    // MESSAGE ID id TYPE type NUMBER n, or MESSAGE text TYPE type
    const parent = source ?? statement;
    const children = parent.getChildren();
    for (let i = 0; i < children.length - 1; i++) {
      if (children[i] instanceof TokenNode && children[i].concatTokens().toUpperCase() === "TYPE") {
        const literal = children[i + 1].concatTokens().match(/^['`]([a-zA-Z])['`]$/);
        return literal ? literal[1].toUpperCase() : undefined;
      }
    }
    return undefined;
  }

  private static listsErrorMessage(statement: StatementNode): boolean {
    const list = statement.findDirectExpression(Expressions.FunctionParameters)?.findDirectExpression(Expressions.ParameterListExceptions);
    return list?.findDirectExpressions(Expressions.ParameterException)
      .some(e => e.getFirstChild()!.concatTokens().toUpperCase() === "ERROR_MESSAGE") === true;
  }

  private static functionName(nameNode: ExpressionNode): string {
    return nameNode.concatTokens().replace(/'/g, "").replace(/`/g, "").toUpperCase();
  }

  private checkCall(file: ABAPFile, token: AbstractToken, callee: ICallee | undefined,
                    parameters: ExpressionNode | undefined, exceptionTable: boolean, destination: boolean,
                    onlyLiterals: boolean): Issue | undefined {
    if (exceptionTable === true) {
      return undefined;
    }

    const list = parameters?.findDirectExpression(Expressions.ParameterListExceptions);
    if (list === undefined) {
      if (this.conf.missingExceptions === false
          || callee === undefined
          || callee.exceptions.length === 0
          || (this.conf.allowLiteralArguments === true && onlyLiterals === true)) {
        return undefined;
      }
      const message = `Classic exceptions of "${callee.name}" not handled: ${callee.exceptions.join(", ")}, call it with EXCEPTIONS`;
      return Issue.atToken(file, token, message, this.getMetadata().key, this.conf.severity);
    }

    if (this.conf.missingOthers === false) {
      return undefined;
    }

    const listed = list.findDirectExpressions(Expressions.ParameterException)
      .map(e => e.getFirstChild()!.concatTokens().toUpperCase());
    if (listed.includes("OTHERS")) {
      return undefined;
    }

    const position = parameters!.findDirectTokenByText("EXCEPTIONS") || list.getFirstToken();

    if (callee === undefined) {
      const message = "EXCEPTIONS without OTHERS, an exception that is not listed ends in a runtime error";
      return Issue.atToken(file, position, message, this.getMetadata().key, this.conf.severity);
    }

    const expected = [...callee.exceptions];
    if (destination === true) {
      expected.push("SYSTEM_FAILURE", "COMMUNICATION_FAILURE");
    }
    const missing = expected.filter(e => listed.includes(e) === false);
    if (missing.length === 0) {
      return undefined;
    }
    const message = `EXCEPTIONS without OTHERS, not mapped: ${missing.join(", ")}`;
    return Issue.atToken(file, position, message, this.getMetadata().key, this.conf.severity);
  }

  /** true if the call has arguments and all of them are literals or me, like describe_by_name( 'T100' ) */
  private onlyLiterals(node: ExpressionNode | undefined): boolean {
    if (node === undefined || node.findFirstExpression(Expressions.MethodCall) !== undefined) {
      return false;
    }
    const sources = node.findAllExpressions(Expressions.Source);
    return sources.length > 0
      && sources.every(s => (s.getChildren().length === 1 && s.getFirstChild()?.get() instanceof Expressions.Constant)
        || s.concatTokens().toUpperCase() === "ME");
  }

  private findMethod(methods: Map<string, MethodDefinition>, token: AbstractToken): ICallee | undefined {
    const method = methods.get(UnhandledClassicException.positionKey(token.getStart()));
    if (method === undefined) {
      return undefined;
    }
    return {
      name: method.getName(),
      exceptions: method.getExceptions().map(e => e.toUpperCase()),
    };
  }

  private findMethodReferences(node: ISpaghettiScopeNode, filename: string, found: Map<string, MethodDefinition>): void {
    for (const r of node.getData().references) {
      if (r.referenceType === ReferenceType.MethodReference
          && r.position.getFilename() === filename
          && r.resolved instanceof MethodDefinition) {
        found.set(UnhandledClassicException.positionKey(r.position.getStart()), r.resolved);
      }
    }

    for (const child of node.getChildren()) {
      this.findMethodReferences(child, filename, found);
    }
  }

  private findFunctionModule(name: string): IKnownModule | undefined {
    if (this.functionModules === undefined) {
      this.functionModules = new Map<string, IKnownModule>();
      for (const fugr of this.reg.getObjectsByType("FUGR")) {
        for (const module of (fugr as FunctionGroup).getModules()) {
          this.functionModules.set(module.getName().toUpperCase(), {definition: module, group: fugr as FunctionGroup});
        }
      }
    }
    return this.functionModules.get(name.toUpperCase());
  }

  private static positionKey(p: Position): string {
    if (p instanceof VirtualPosition) {
      return p.getRow() + ":" + p.getCol() + ":" + p.vrow + ":" + p.vcol;
    }
    return p.getRow() + ":" + p.getCol();
  }

}
