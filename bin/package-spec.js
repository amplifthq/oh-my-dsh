export function profilePackageSpec({ sourceCheckout, packageRoot, version }) {
  return sourceCheckout ? `file:${packageRoot}` : version
}
