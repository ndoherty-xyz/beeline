// What counts as a target: elements a click is likely to do something on. Shared by the extension and the dataset converters.

export const TARGET_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "summary",
  "label[for]",
  ...["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem"].map(
    (role) => `[role=${role}]`,
  ),
  "[onclick]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");
