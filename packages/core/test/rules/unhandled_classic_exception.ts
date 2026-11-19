import {expect} from "chai";
import {UnhandledClassicException, UnhandledClassicExceptionConf} from "../../src/rules";
import {Registry} from "../../src/registry";
import {MemoryFile} from "../../src/files/memory_file";
import {Issue} from "../../src/issue";
import {SyntaxLogic} from "../../src/abap/5_syntax/syntax";
import {ABAPObject} from "../../src/objects/_abap_object";

const classes = `
CLASS lcl_typedescr DEFINITION.
  PUBLIC SECTION.
    CLASS-METHODS describe_by_name
      IMPORTING
        p_name         TYPE any
      RETURNING
        VALUE(p_descr) TYPE REF TO lcl_typedescr
      EXCEPTIONS
        type_not_found.
    CLASS-METHODS describe_by_object_ref
      IMPORTING
        p_ref          TYPE REF TO object
      RETURNING
        VALUE(p_descr) TYPE REF TO lcl_typedescr
      EXCEPTIONS
        reference_is_initial.
    CLASS-METHODS read
      IMPORTING
        iv_key  TYPE string OPTIONAL
      EXCEPTIONS
        not_found
        invalid.
    CLASS-METHODS plain
      IMPORTING
        iv_key        TYPE string OPTIONAL
      RETURNING
        VALUE(rv_val) TYPE string.
    METHODS get_name
      RETURNING
        VALUE(rv_name) TYPE string
      EXCEPTIONS
        no_name.
ENDCLASS.

CLASS lcl_typedescr IMPLEMENTATION.
  METHOD describe_by_name.
  ENDMETHOD.
  METHOD describe_by_object_ref.
  ENDMETHOD.
  METHOD read.
  ENDMETHOD.
  METHOD plain.
  ENDMETHOD.
  METHOD get_name.
  ENDMETHOD.
ENDCLASS.

CLASS lcl_classdescr DEFINITION INHERITING FROM lcl_typedescr.
ENDCLASS.

CLASS lcl_classdescr IMPLEMENTATION.
ENDCLASS.

INTERFACE lif_reader.
  METHODS read
    EXCEPTIONS
      not_found.
ENDINTERFACE.

CLASS lcl_reader DEFINITION.
  PUBLIC SECTION.
    INTERFACES lif_reader.
    METHODS run.
ENDCLASS.

CLASS lcl_reader IMPLEMENTATION.
  METHOD lif_reader~read.
  ENDMETHOD.
  METHOD run.
    DATA lo_descr TYPE REF TO lcl_typedescr.
    lo_descr = lcl_typedescr=>describe_by_object_ref( me ).
  ENDMETHOD.
ENDCLASS.

START-OF-SELECTION.
  DATA lo_type TYPE REF TO lcl_typedescr.
  DATA lo_obj TYPE REF TO object.
  DATA li_reader TYPE REF TO lif_reader.
  DATA lv_name TYPE string.
  DATA lv_fm TYPE string.
`;

function buildFugr(exceptions: string[], classBased = false): string {
  const rows = exceptions.map(e => `<RSEXC><EXCEPTION>${e}</EXCEPTION></RSEXC>`).join("");
  return `<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_FUGR" serializer_version="v1.0.0">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values>
   <AREAT>test</AREAT>
   <INCLUDES>
    <SOBJ_NAME>LZFOOTOP</SOBJ_NAME>
    <SOBJ_NAME>SAPLZFOO</SOBJ_NAME>
   </INCLUDES>
   <FUNCTIONS>
    <item>
     <FUNCNAME>Z_READ</FUNCNAME>
     <SHORT_TEXT>test</SHORT_TEXT>
     ${classBased ? "<EXCEPTION_CLASSES>X</EXCEPTION_CLASSES>" : ""}
     <EXCEPTION>${rows}</EXCEPTION>
    </item>
   </FUNCTIONS>
  </asx:values>
 </asx:abap>
</abapGit>`;
}

async function findIssues(abap: string, config?: Partial<UnhandledClassicExceptionConf>, fugr?: string): Promise<readonly Issue[]> {
  const reg = new Registry();
  reg.addFile(new MemoryFile("zfoo.prog.abap", classes + abap));
  if (fugr) {
    reg.addFile(new MemoryFile("zfoo.fugr.xml", fugr));
    reg.addFile(new MemoryFile("zfoo.fugr.saplzfoo.abap", "FUNCTION-POOL zfoo."));
    reg.addFile(new MemoryFile("zfoo.fugr.z_read.abap", "FUNCTION z_read.\nENDFUNCTION."));
  }
  await reg.parseAsync();
  const prog = reg.getFirstObject()! as ABAPObject;
  // the rule is silent on syntax errors, so make sure the input is valid
  expect(new SyntaxLogic(reg, prog).run().issues.map(i => i.getMessage())).to.deep.equal([]);

  const rule = new UnhandledClassicException();
  if (config) {
    rule.setConfig({...new UnhandledClassicExceptionConf(), ...config});
  }
  return rule.initialize(reg).run(prog);
}

interface IModule {
  name: string;
  exceptions?: string[];
  classBased?: boolean;
  body?: string;
}

/** a function group ZMSG with the given function modules and their source, plus extra includes, for example forms */
function buildModules(modules: IModule[], include?: string): MemoryFile[] {
  const functions = modules.map(m => `<item>
     <FUNCNAME>${m.name}</FUNCNAME>
     <SHORT_TEXT>test</SHORT_TEXT>
     ${m.classBased ? "<EXCEPTION_CLASSES>X</EXCEPTION_CLASSES>" : ""}
     <EXCEPTION>${(m.exceptions || []).map(e => `<RSEXC><EXCEPTION>${e}</EXCEPTION></RSEXC>`).join("")}</EXCEPTION>
    </item>`).join("\n");
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_FUGR" serializer_version="v1.0.0">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values>
   <AREAT>test</AREAT>
   <INCLUDES>
    <SOBJ_NAME>LZMSGF01</SOBJ_NAME>
    <SOBJ_NAME>SAPLZMSG</SOBJ_NAME>
   </INCLUDES>
   <FUNCTIONS>
    ${functions}
   </FUNCTIONS>
  </asx:values>
 </asx:abap>
</abapGit>`;
  const files = [
    new MemoryFile("zmsg.fugr.xml", xml),
    new MemoryFile("zmsg.fugr.saplzmsg.abap", "FUNCTION-POOL zmsg.\nINCLUDE lzmsgf01."),
    new MemoryFile("zmsg.fugr.lzmsgf01.abap", include || ""),
  ];
  for (const m of modules) {
    files.push(new MemoryFile(`zmsg.fugr.${m.name.toLowerCase()}.abap`, `FUNCTION ${m.name.toLowerCase()}.\n${m.body || ""}\nENDFUNCTION.`));
  }
  return files;
}

async function findErrorMessageIssues(abap: string, modules: IModule[], include?: string,
                                      config?: Partial<UnhandledClassicExceptionConf>): Promise<readonly Issue[]> {
  const reg = new Registry();
  reg.addFile(new MemoryFile("zfoo.prog.abap", classes + abap));
  for (const f of buildModules(modules, include)) {
    reg.addFile(f);
  }
  await reg.parseAsync();
  const prog = reg.getFirstObject()! as ABAPObject;
  expect(new SyntaxLogic(reg, prog).run().issues.map(i => i.getMessage())).to.deep.equal([]);
  for (const o of reg.getObjects()) {
    expect(new SyntaxLogic(reg, o as ABAPObject).run().issues.map(i => i.getMessage())).to.deep.equal([]);
  }

  const rule = new UnhandledClassicException();
  rule.setConfig({...new UnhandledClassicExceptionConf(), ...config});
  return rule.initialize(reg).run(prog).filter(i => i.getMessage().includes("error_message"));
}

describe("Rule: unhandled_classic_exception", () => {

  it("parser error, no issues", async () => {
    const reg = new Registry().addFile(new MemoryFile("zfoo.prog.abap", "parser error"));
    await reg.parseAsync();
    const issues = new UnhandledClassicException().initialize(reg).run(reg.getFirstObject()!);
    expect(issues.length).to.equal(0);
  });

  it("syntax error, no issues", async () => {
    const reg = new Registry().addFile(new MemoryFile("zfoo.prog.abap", `
CALL FUNCTION 'Z_READ'
  EXCEPTIONS
    not_found = 1.
WRITE lv_unknown.`));
    await reg.parseAsync();
    const issues = new UnhandledClassicException().initialize(reg).run(reg.getFirstObject()!);
    expect(issues.length).to.equal(0);
  });

  describe("missingOthers", () => {

    it("CALL FUNCTION of an unknown function module without OTHERS", async () => {
      const issues = await findIssues(`
  CALL FUNCTION 'Z_READ'
    EXCEPTIONS
      not_found = 1.`);
      expect(issues.length).to.equal(1);
      expect(issues[0].getMessage()).to.contain("without OTHERS");
      expect(issues[0].getStart().getRow()).to.equal(84);
      expect(issues[0].getKey()).to.equal("unhandled_classic_exception");
    });

    it("CALL FUNCTION with OTHERS", async () => {
      const issues = await findIssues(`
  CALL FUNCTION 'Z_READ'
    EXCEPTIONS
      not_found = 1
      OTHERS    = 2.`);
      expect(issues.length).to.equal(0);
    });

    it("OTHERS = 0 is not reported", async () => {
      const issues = await findIssues(`
  CALL FUNCTION 'Z_READ'
    EXCEPTIONS
      OTHERS = 0.`);
      expect(issues.length).to.equal(0);
    });

    it("CALL FUNCTION without EXCEPTIONS, unknown function module", async () => {
      const issues = await findIssues(`
  CALL FUNCTION 'Z_READ'.`);
      expect(issues.length).to.equal(0);
    });

    it("dynamic function module name", async () => {
      const issues = await findIssues(`
  lv_fm = 'Z_READ'.
  CALL FUNCTION lv_fm
    EXCEPTIONS
      not_found = 1.`);
      expect(issues.length).to.equal(1);
    });

    it("EXCEPTION-TABLE", async () => {
      const issues = await findIssues(`
  DATA lt_exc TYPE abap_func_excpbind_tab.
  CALL FUNCTION 'Z_READ'
    EXCEPTION-TABLE lt_exc.`);
      expect(issues.length).to.equal(0);
    });

    it("STARTING NEW TASK", async () => {
      const issues = await findIssues(`
  CALL FUNCTION 'Z_READ' STARTING NEW TASK 'TASK'
    EXCEPTIONS
      communication_failure = 1
      system_failure        = 2.`);
      expect(issues.length).to.equal(0);
    });

    it("known function module, every exception listed", async () => {
      const issues = await findIssues(`
  CALL FUNCTION 'Z_READ'
    EXCEPTIONS
      not_found = 1
      invalid   = 2.`, undefined, buildFugr(["NOT_FOUND", "INVALID"]));
      expect(issues.length).to.equal(0);
    });

    it("known function module, one exception missing", async () => {
      const issues = await findIssues(`
  CALL FUNCTION 'Z_READ'
    EXCEPTIONS
      not_found = 1.`, undefined, buildFugr(["NOT_FOUND", "INVALID"]));
      expect(issues.length).to.equal(1);
      expect(issues[0].getMessage()).to.contain("INVALID");
    });

    it("known function module, DESTINATION also needs SYSTEM_FAILURE and COMMUNICATION_FAILURE", async () => {
      const issues = await findIssues(`
  CALL FUNCTION 'Z_READ' DESTINATION 'NONE'
    EXCEPTIONS
      not_found = 1
      invalid   = 2.`, undefined, buildFugr(["NOT_FOUND", "INVALID"]));
      expect(issues.length).to.equal(1);
      expect(issues[0].getMessage()).to.contain("SYSTEM_FAILURE, COMMUNICATION_FAILURE");
    });

    it("known function module, DESTINATION, everything listed", async () => {
      const issues = await findIssues(`
  CALL FUNCTION 'Z_READ' DESTINATION 'NONE'
    EXCEPTIONS
      not_found             = 1
      invalid               = 2
      system_failure        = 3
      communication_failure = 4.`, undefined, buildFugr(["NOT_FOUND", "INVALID"]));
      expect(issues.length).to.equal(0);
    });

    it("CALL METHOD, known method, one exception missing", async () => {
      const issues = await findIssues(`
  CALL METHOD lcl_typedescr=>read
    EXCEPTIONS
      not_found = 1.`);
      expect(issues.length).to.equal(1);
      expect(issues[0].getMessage()).to.contain("INVALID");
    });

    it("method call, known method, one exception missing", async () => {
      const issues = await findIssues(`
  lcl_typedescr=>read(
    EXPORTING
      iv_key    = lv_name
    EXCEPTIONS
      not_found = 1 ).`);
      expect(issues.length).to.equal(1);
    });

    it("method call, known method, every exception listed", async () => {
      const issues = await findIssues(`
  lcl_typedescr=>read(
    EXCEPTIONS
      not_found = 1
      invalid   = 2 ).
  lcl_classdescr=>describe_by_name(
    EXPORTING
      p_name         = lv_name
    RECEIVING
      p_descr        = lo_type
    EXCEPTIONS
      type_not_found = 1 ).`);
      expect(issues.length).to.equal(0);
    });

    it("method call of an unknown method", async () => {
      const issues = await findIssues(`
  cl_gui_frontend_services=>get_sapgui_workdir(
    CHANGING
      sapworkdir            = lv_name
    EXCEPTIONS
      get_sapworkdir_failed = 1 ).`);
      expect(issues.length).to.equal(1);
    });

    it("dynamic CALL METHOD", async () => {
      const issues = await findIssues(`
  CALL METHOD lo_obj->(lv_name)
    EXCEPTIONS
      not_found = 1.`);
      expect(issues.length).to.equal(1);
    });

    it("option off", async () => {
      const issues = await findIssues(`
  CALL FUNCTION 'Z_READ'
    EXCEPTIONS
      not_found = 1.`, {missingOthers: false});
      expect(issues.length).to.equal(0);
    });

  });

  describe("missingExceptions", () => {

    it("functional call of a method with classic exceptions", async () => {
      const issues = await findIssues(`
  lo_type = lcl_typedescr=>describe_by_name( lv_name ).`);
      expect(issues.length).to.equal(1);
      expect(issues[0].getMessage()).to.contain("TYPE_NOT_FOUND");
      expect(issues[0].getStart().getRow()).to.equal(83);
      expect(issues[0].getStart().getCol()).to.equal(28);
    });

    it("inherited method", async () => {
      const issues = await findIssues(`
  lo_type = lcl_classdescr=>describe_by_name( lv_name ).`);
      expect(issues.length).to.equal(1);
    });

    it("inside a TRY, which does not catch classic exceptions", async () => {
      const issues = await findIssues(`
  TRY.
      lo_type = lcl_typedescr=>describe_by_name( lv_name ).
    CATCH cx_root.
      RETURN.
  ENDTRY.`);
      expect(issues.length).to.equal(1);
    });

    it("nested functional call", async () => {
      const issues = await findIssues(`
  lv_name = lcl_typedescr=>plain( lo_type->describe_by_name( lv_name )->get_name( ) ).`);
      expect(issues.length).to.equal(2);
    });

    it("standalone call without EXCEPTIONS", async () => {
      const issues = await findIssues(`
  lcl_typedescr=>read( lv_name ).
  CALL METHOD lcl_typedescr=>read.`);
      expect(issues.length).to.equal(2);
    });

    it("interface method", async () => {
      const issues = await findIssues(`
  li_reader->read( ).`);
      expect(issues.length).to.equal(1);
    });

    it("chained call, only the first call is reported", async () => {
      const issues = await findIssues(`
  lcl_typedescr=>describe_by_name( lv_name )->get_name(
    RECEIVING
      rv_name = lv_name
    EXCEPTIONS
      no_name = 1
      OTHERS  = 2 ).`);
      expect(issues.length).to.equal(1);
      expect(issues[0].getMessage()).to.contain("describe_by_name");
    });

    it("method without classic exceptions", async () => {
      const issues = await findIssues(`
  lv_name = lcl_typedescr=>plain( lv_name ).`);
      expect(issues.length).to.equal(0);
    });

    it("unknown method", async () => {
      const issues = await findIssues(`
  lo_obj = cl_abap_typedescr=>describe_by_name( lv_name ).`);
      expect(issues.length).to.equal(0);
    });

    it("literal argument and me are not reported by default", async () => {
      const issues = await findIssues(`
  lo_type = lcl_typedescr=>describe_by_name( 'T100' ).
  lo_type = lcl_typedescr=>describe_by_name( p_name = \`T100\` ).`);
      expect(issues.length).to.equal(0);
    });

    it("literal argument and me, allowLiteralArguments off", async () => {
      const issues = await findIssues(`
  lo_type = lcl_typedescr=>describe_by_name( 'T100' ).`, {allowLiteralArguments: false});
      expect(issues.length).to.equal(2);
    });

    it("call without arguments is not a literal call", async () => {
      const issues = await findIssues(`
  lv_name = lo_type->get_name( ).`);
      expect(issues.length).to.equal(1);
    });

    it("known function module called without EXCEPTIONS", async () => {
      const issues = await findIssues(`
  CALL FUNCTION 'Z_READ'.`, undefined, buildFugr(["NOT_FOUND"]));
      expect(issues.length).to.equal(1);
      expect(issues[0].getMessage()).to.contain("Z_READ");
    });

    it("known function module with class-based exceptions", async () => {
      const issues = await findIssues(`
  CALL FUNCTION 'Z_READ'.`, undefined, buildFugr(["ZCX_ERROR"], true));
      expect(issues.length).to.equal(0);
    });

    it("known function module IN UPDATE TASK", async () => {
      const issues = await findIssues(`
  CALL FUNCTION 'Z_READ' IN UPDATE TASK.`, undefined, buildFugr(["NOT_FOUND"]));
      expect(issues.length).to.equal(0);
    });

    it("option off", async () => {
      const issues = await findIssues(`
  lo_type = lcl_typedescr=>describe_by_name( lv_name ).`, {missingExceptions: false});
      expect(issues.length).to.equal(0);
    });

  });

  describe("missingErrorMessage", () => {

    it("known function module sends a type E message, EXCEPTIONS has OTHERS", async () => {
      const issues = await findErrorMessageIssues(`
  CALL FUNCTION 'Z_CHECK'
    EXCEPTIONS
      OTHERS = 1.`, [{name: "Z_CHECK", body: "  MESSAGE e001(zz)."}]);
      expect(issues.length).to.equal(1);
      expect(issues[0].getMessage()).to.equal(
        `"Z_CHECK" can send a message of type E, add error_message to EXCEPTIONS, OTHERS does not catch it`);
      expect(issues[0].getStart().getRow()).to.equal(84);
    });

    it("known function module sends a type A message, call without EXCEPTIONS", async () => {
      const issues = await findErrorMessageIssues(`
  CALL FUNCTION 'Z_CHECK'.`, [{name: "Z_CHECK", body: "  MESSAGE 'Failed' TYPE 'A'."}]);
      expect(issues.length).to.equal(1);
      expect(issues[0].getMessage()).to.contain("type A");
      expect(issues[0].getStart().getRow()).to.equal(83);
    });

    it("dynamic message type", async () => {
      const issues = await findErrorMessageIssues(`
  CALL FUNCTION 'Z_CHECK'
    EXCEPTIONS
      OTHERS = 1.`, [{name: "Z_CHECK", body: "  MESSAGE ID sy-msgid TYPE sy-msgty NUMBER sy-msgno."}]);
      expect(issues.length).to.equal(1);
      expect(issues[0].getMessage()).to.contain("dynamic type");
    });

    it("message text in a variable called type", async () => {
      const issues = await findErrorMessageIssues(`
  CALL FUNCTION 'Z_CHECK'.`, [{name: "Z_CHECK", body: "  DATA type TYPE string.\n  MESSAGE type TYPE 'S'."}]);
      expect(issues.length).to.equal(0);
    });

    it("MESSAGE ID with literal type E", async () => {
      const issues = await findErrorMessageIssues(`
  CALL FUNCTION 'Z_CHECK'.`, [{name: "Z_CHECK", body: "  MESSAGE ID 'ZZ' TYPE 'E' NUMBER '001'."}]);
      expect(issues.length).to.equal(1);
    });

    it("message in a form of the function group", async () => {
      const issues = await findErrorMessageIssues(`
  CALL FUNCTION 'Z_CHECK'
    EXCEPTIONS
      OTHERS = 1.`, [{name: "Z_CHECK", body: "  PERFORM check."}], `FORM check.
  MESSAGE e001(zz).
ENDFORM.`);
      expect(issues.length).to.equal(1);
      expect(issues[0].getMessage()).to.contain(`via "CHECK"`);
    });

    it("message in a function module that the called function module calls", async () => {
      const issues = await findErrorMessageIssues(`
  CALL FUNCTION 'Z_OUTER'
    EXCEPTIONS
      OTHERS = 1.`, [{name: "Z_OUTER", body: "  CALL FUNCTION 'Z_INNER'."}, {name: "Z_INNER", body: "  MESSAGE e001(zz)."}]);
      expect(issues.length).to.equal(1);
      expect(issues[0].getMessage()).to.contain(`"Z_OUTER" can send a message of type E via "Z_INNER"`);
    });

    it("nested call that lists error_message itself", async () => {
      const issues = await findErrorMessageIssues(`
  CALL FUNCTION 'Z_OUTER'
    EXCEPTIONS
      OTHERS = 1.`, [{name: "Z_OUTER", body: `  CALL FUNCTION 'Z_INNER'
    EXCEPTIONS
      error_message = 1
      OTHERS        = 2.`}, {name: "Z_INNER", body: "  MESSAGE e001(zz)."}]);
      expect(issues.length).to.equal(0);
    });

    it("recursive function module", async () => {
      const issues = await findErrorMessageIssues(`
  CALL FUNCTION 'Z_CHECK'
    EXCEPTIONS
      OTHERS = 1.`, [{name: "Z_CHECK", body: "  CALL FUNCTION 'Z_CHECK'."}]);
      expect(issues.length).to.equal(0);
    });

    it("error_message listed", async () => {
      const issues = await findErrorMessageIssues(`
  CALL FUNCTION 'Z_CHECK'
    EXCEPTIONS
      error_message = 1
      OTHERS        = 2.`, [{name: "Z_CHECK", body: "  MESSAGE e001(zz)."}]);
      expect(issues.length).to.equal(0);
    });

    it("MESSAGE ... RAISING is a classic exception, not reported", async () => {
      const issues = await findErrorMessageIssues(`
  CALL FUNCTION 'Z_CHECK'
    EXCEPTIONS
      not_found = 1
      OTHERS    = 2.`, [{name: "Z_CHECK", exceptions: ["NOT_FOUND"], body: "  MESSAGE e001(zz) RAISING not_found."}]);
      expect(issues.length).to.equal(0);
    });

    it("MESSAGE ... INTO is not sent", async () => {
      const issues = await findErrorMessageIssues(`
  CALL FUNCTION 'Z_CHECK'.`, [{name: "Z_CHECK", body: "  DATA lv_text TYPE string.\n  MESSAGE e001(zz) INTO lv_text."}]);
      expect(issues.length).to.equal(0);
    });

    it("types I, S, W and X are not reported", async () => {
      const issues = await findErrorMessageIssues(`
  CALL FUNCTION 'Z_CHECK'.`, [{name: "Z_CHECK", body: `  MESSAGE i001(zz).
  MESSAGE s001(zz).
  MESSAGE 'Careful' TYPE 'W'.
  MESSAGE x001(zz).`}]);
      expect(issues.length).to.equal(0);
    });

    it("message in a function module of the group that is not called", async () => {
      const issues = await findErrorMessageIssues(`
  CALL FUNCTION 'Z_CHECK'.`, [{name: "Z_CHECK"}, {name: "Z_OTHER", body: "  MESSAGE e001(zz)."}]);
      expect(issues.length).to.equal(0);
    });

    it("DESTINATION, STARTING NEW TASK and IN UPDATE TASK are not reported", async () => {
      const issues = await findErrorMessageIssues(`
  CALL FUNCTION 'Z_CHECK' DESTINATION 'NONE'
    EXCEPTIONS
      system_failure        = 1
      communication_failure = 2
      OTHERS                = 3.
  CALL FUNCTION 'Z_CHECK' STARTING NEW TASK 'TASK'.
  CALL FUNCTION 'Z_CHECK' IN UPDATE TASK.`, [{name: "Z_CHECK", body: "  MESSAGE e001(zz)."}]);
      expect(issues.length).to.equal(0);
    });

    it("function module with class-based exceptions", async () => {
      const issues = await findErrorMessageIssues(`
  CALL FUNCTION 'Z_CHECK'.`, [{name: "Z_CHECK", classBased: true, body: "  MESSAGE e001(zz)."}]);
      expect(issues.length).to.equal(0);
    });

    it("unknown function module is not reported by default", async () => {
      const issues = await findErrorMessageIssues(`
  CALL FUNCTION 'CONVERSION_EXIT_SDATE_INPUT'
    EXCEPTIONS
      OTHERS = 1.`, []);
      expect(issues.length).to.equal(0);
    });

    it("errorMessageVoid, unknown and dynamic function modules", async () => {
      const issues = await findErrorMessageIssues(`
  CALL FUNCTION 'CONVERSION_EXIT_SDATE_INPUT'
    EXCEPTIONS
      OTHERS = 1.
  lv_fm = 'SEO_CLASS_READ'.
  CALL FUNCTION lv_fm.
  CALL FUNCTION lv_fm
    EXCEPTIONS
      error_message = 1
      OTHERS        = 2.`, [], undefined, {errorMessageVoid: true});
      expect(issues.length).to.equal(2);
      expect(issues[0].getMessage()).to.equal("No error_message, OTHERS does not catch a message that the function module sends without RAISING");
      expect(issues[0].getStart().getRow()).to.equal(84);
      expect(issues[1].getStart().getRow()).to.equal(87);
    });

    it("errorMessageVoid does not report a known function module without messages", async () => {
      const issues = await findErrorMessageIssues(`
  CALL FUNCTION 'Z_CHECK'.`, [{name: "Z_CHECK"}], undefined, {errorMessageVoid: true});
      expect(issues.length).to.equal(0);
    });

    it("option off", async () => {
      const issues = await findErrorMessageIssues(`
  CALL FUNCTION 'Z_CHECK'.`, [{name: "Z_CHECK", body: "  MESSAGE e001(zz)."}], undefined,
                                                  {missingErrorMessage: false, errorMessageVoid: true});
      expect(issues.length).to.equal(0);
    });

  });

});
