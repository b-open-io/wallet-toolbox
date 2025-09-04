import { AuthMethodInteractor, AuthPayload, StartAuthResponse, CompleteAuthResponse } from './AuthMethodInteractor'

/**
 * DevConsoleInteractor
 *
 * A client-side class that knows how to call the WAB server for DevConsole-based authentication.
 * This is a development-only auth method that generates OTP codes and logs them to the console.
 */
export class DevConsoleInteractor extends AuthMethodInteractor {
  public methodType = 'DevConsole'

  /**
   * Start the DevConsole authentication on the server.
   * - The server will generate an OTP code and log it to the console for development use.
   * @param serverUrl         - The base URL of the WAB server (e.g. http://localhost:3000)
   * @param presentationKey   - The 256-bit key the client is attempting to authenticate with
   * @param payload           - { phoneNumber: string } (identifier for the authentication)
   * @returns                 - { success, message, data }
   */
  public async startAuth(serverUrl: string, presentationKey: string, payload: AuthPayload): Promise<StartAuthResponse> {
    const res = await fetch(`${serverUrl}/auth/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        methodType: this.methodType,
        presentationKey,
        payload
      })
    })

    if (!res.ok) {
      return {
        success: false,
        message: `HTTP error ${res.status}`
      }
    }

    return res.json()
  }

  /**
   * Complete the DevConsole authentication on the server.
   * - The server will verify the OTP code that was generated and logged to the console.
   * @param serverUrl         - The base URL of the WAB server
   * @param presentationKey   - The 256-bit key
   * @param payload           - { phoneNumber: string, otp: string } (the identifier and OTP code from console)
   * @returns                 - { success, message, presentationKey }
   */
  public async completeAuth(
    serverUrl: string,
    presentationKey: string,
    payload: AuthPayload
  ): Promise<CompleteAuthResponse> {
    const res = await fetch(`${serverUrl}/auth/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        methodType: this.methodType,
        presentationKey,
        payload
      })
    })

    if (!res.ok) {
      return {
        success: false,
        message: `HTTP error ${res.status}`
      }
    }

    return res.json()
  }
}
