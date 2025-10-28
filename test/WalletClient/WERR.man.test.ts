import { CreateActionArgs, WalletClient } from '@bsv/sdk'
import { specOpThrowReviewActions } from '../../src/sdk/types'
import { WalletError } from '../../src/sdk/WalletError'
import { WERR_REVIEW_ACTIONS } from '../../src/sdk/WERR_errors'
import { validateCreateActionArgs } from '../../src/sdk'

test('0 WERR_REVIEW_ACTIONS via WalletClient', async () => {
  const wallet = new WalletClient('auto', '0.WERR.man.test')

  const args: CreateActionArgs = {
    labels: [specOpThrowReviewActions],
    description: 'must throw'
  }
  const vargs = validateCreateActionArgs(args)

  try {
    const r = await wallet.createAction(args)
    expect(true).toBe(false)
  } catch (eu: unknown) {
    const e = WalletError.fromUnknown(eu) as WERR_REVIEW_ACTIONS
    expect(e.code).toBe('WERR_REVIEW_ACTIONS')
    expect(e.reviewActionResults).toBeTruthy()
  }
})
