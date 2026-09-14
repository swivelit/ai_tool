const forbidden = /[\u0000-\u001f\u007f"%\r\n]/

/**
 * Build the fixed cmd.exe boundary used only for the generated npm shim.
 * The outer quotes are required by cmd /s /c when its command starts with a
 * quoted executable path. Node must receive this argv verbatim on Windows.
 */
export function quoteCmd(value) {
  const text = String(value)
  if (forbidden.test(text)) throw new Error('Unsupported Windows shim argument: control characters, quotes, and percent expansion are not accepted.')
  return `"${text}"`
}

export function windowsShimInvocation(shim, args = []) {
  const command = `"${[quoteCmd(shim), ...args.map(quoteCmd)].join(' ')}"`
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/v:off', '/s', '/c', command],
    options: { windowsVerbatimArguments: true, windowsHide: true },
  }
}
