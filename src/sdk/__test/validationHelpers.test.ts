import { Utils } from '@bsv/sdk'
import { validateBase64String } from '../validationHelpers'
describe('validationHelpers tests', () => {
    jest.setTimeout(99999999)

    test('0 validateBase64String', async () => {
        
      const validB64 = 'SGVsbG8gV29ybGQh' // "Hello World!"

      const s = validateBase64String(validB64, 'testParam', 1, 20)
      expect(s).toBe(validB64)

      {
        const invalidB64 = 'SGVsbG8g29ybGQh'
        expect(() => validateBase64String(invalidB64, 'testParam', 1, 20)).toThrow()
      }

      {
        const invalidB64 = 'SGVsbG8gV29ybGQh='
        expect(() => validateBase64String(invalidB64, 'testParam', 1, 20)).toThrow()
      }
    })
})