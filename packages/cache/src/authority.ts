const roleSeal: unique symbol = Symbol("odu:cache/role");

export type Authority =
  | { readonly kind: "root"; readonly rootToken: string }
  | { readonly kind: "role"; readonly login: string; readonly [roleSeal]: true };

export function roleAuthority(login: string): Authority {
  return { kind: "role", login, [roleSeal]: true };
}

export function mintedByThisRow(authority: Authority): boolean {
  return authority.kind === "role" && roleSeal in authority && authority[roleSeal] === true;
}
