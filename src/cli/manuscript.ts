import { deliverManuscript, type ManuscriptDelivery } from '../main/manuscriptDelivery'

export const publishCliManuscript = (input: ManuscriptDelivery) => deliverManuscript(input, 'terminal')
