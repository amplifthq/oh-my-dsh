/**
 * IP address classification for SSRF protection — the pure, network-free half.
 * The fetch provider rejects private, loopback, link-local, and otherwise
 * reserved destinations both for IP-literal hosts (before any request) and for
 * every DNS-resolved address (at connect time, so rebinding cannot slip past).
 * @module @oh-my-dsh/web-guard/address
 */

/** Parse a dotted-quad IPv4 literal into a 32-bit unsigned value. */
function parseIpv4(host: string): number | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (match === null) return undefined
  let value = 0
  for (let index = 1; index <= 4; index++) {
    const octet = Number(match[index])
    if (octet > 255) return undefined
    value = value * 256 + octet
  }
  return value
}

/** Blocked IPv4 ranges as [base, prefixLength]. */
const BLOCKED_V4: Array<[number, number]> = [
  [0x00000000, 8], // 0.0.0.0/8 "this network"
  [0x0a000000, 8], // 10.0.0.0/8 private
  [0x64400000, 10], // 100.64.0.0/10 CGNAT
  [0x7f000000, 8], // 127.0.0.0/8 loopback
  [0xa9fe0000, 16], // 169.254.0.0/16 link-local (cloud metadata)
  [0xac100000, 12], // 172.16.0.0/12 private
  [0xc0000000, 24], // 192.0.0.0/24 IETF protocol assignments
  [0xc0000200, 24], // 192.0.2.0/24 TEST-NET-1
  [0xc0a80000, 16], // 192.168.0.0/16 private
  [0xc6120000, 15], // 198.18.0.0/15 benchmarking
  [0xc6336400, 24], // 198.51.100.0/24 TEST-NET-2
  [0xcb007100, 24], // 203.0.113.0/24 TEST-NET-3
  [0xe0000000, 4], // 224.0.0.0/4 multicast
  [0xf0000000, 4], // 240.0.0.0/4 reserved + broadcast
]

function isBlockedIpv4(value: number): boolean {
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0
    // >>> 0 keeps both sides unsigned; bitwise AND coerces to signed int32.
    return ((value & mask) >>> 0) === ((base & mask) >>> 0)
  })
}

/**
 * Expand an IPv6 literal into its eight 16-bit groups, or undefined when the
 * input is not valid IPv6. Accepts an embedded trailing IPv4 dotted-quad
 * (`::ffff:127.0.0.1`).
 */
export function expandIpv6(host: string): number[] | undefined {
  let input = host.toLowerCase()
  // Zone index (fe80::1%en0) — the zoned form is inherently link-local scoped.
  const zone = input.indexOf('%')
  if (zone !== -1) input = input.slice(0, zone)
  const parts = input.split('::')
  if (parts.length > 2) return undefined

  const parseGroups = (section: string): number[] | undefined => {
    if (section === '') return []
    const groups: number[] = []
    for (const raw of section.split(':')) {
      const v4 = parseIpv4(raw)
      if (v4 !== undefined && raw.includes('.')) {
        groups.push((v4 >>> 16) & 0xffff, v4 & 0xffff)
        continue
      }
      if (!/^[0-9a-f]{1,4}$/.test(raw)) return undefined
      groups.push(Number.parseInt(raw, 16))
    }
    return groups
  }

  const head = parseGroups(parts[0])
  if (head === undefined) return undefined
  if (parts.length === 1) return head.length === 8 ? head : undefined
  const tail = parseGroups(parts[1])
  if (tail === undefined) return undefined
  const fill = 8 - head.length - tail.length
  if (fill < 1) return undefined
  return [...head, ...Array.from({ length: fill }, () => 0), ...tail]
}

function isBlockedIpv6(groups: number[]): boolean {
  const allZero = groups.every((group) => group === 0)
  if (allZero) return true // ::
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true // ::1
  if ((groups[0] & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((groups[0] & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((groups[0] & 0xff00) === 0xff00) return true // ff00::/8 multicast
  // ::ffff:0:0/96 IPv4-mapped — classify the embedded IPv4.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return isBlockedIpv4(((groups[6] << 16) | groups[7]) >>> 0)
  }
  // 64:ff9b::/96 NAT64 — classify the embedded IPv4.
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
    return isBlockedIpv4(((groups[6] << 16) | groups[7]) >>> 0)
  }
  return false
}

/**
 * Whether a single resolved or literal IP address must not be dialed.
 * Non-address input (a hostname) returns false — names are classified after
 * DNS resolution, not here.
 */
export function isForbiddenAddress(address: string): boolean {
  const v4 = parseIpv4(address)
  if (v4 !== undefined) return isBlockedIpv4(v4)
  if (address.includes(':')) {
    const groups = expandIpv6(address)
    if (groups === undefined) return false
    return isBlockedIpv6(groups)
  }
  return false
}

/** Hostnames that name the local machine or a private network without being IP literals. */
const LOCAL_NAME_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa']

/**
 * Whether a URL hostname is a private/reserved destination decidable without
 * DNS: an IP literal in a blocked range, or a conventionally local name.
 * Public-looking names return false; their resolved addresses are checked at
 * connect time instead.
 */
export function isPrivateHost(hostname: string): boolean {
  // WHATWG URL keeps brackets on IPv6 hostnames.
  const host = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
  if (host === 'localhost') return true
  const lower = host.toLowerCase()
  if (LOCAL_NAME_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return true
  return isForbiddenAddress(host)
}
