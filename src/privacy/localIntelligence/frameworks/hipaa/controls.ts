import type { CompliancePolicy } from '../../types'
import { hipaaRules } from './rules'

export const hipaaPolicy: CompliancePolicy = {
  id: 'HIPAA',
  name: 'HIPAA',
  version: '2026.1',
  description: 'Healthcare privacy and electronic protected health information safeguards.',
  controls: [
    { id: '164.312(a)', name: 'Access Control', description: 'Authorize access to electronic PHI.', rules: hipaaRules.filter(rule => rule.control === '164.312(a)') },
    { id: '164.312(b)', name: 'Audit Controls', description: 'Record and examine activity involving electronic PHI.', rules: hipaaRules.filter(rule => rule.control === '164.312(b)') },
    { id: '164.312(c)', name: 'Integrity Controls', description: 'Protect PHI from improper alteration or destruction.', rules: hipaaRules.filter(rule => rule.control === '164.312(c)') },
    { id: '164.312(e)', name: 'Transmission Security', description: 'Protect PHI transmitted over electronic networks.', rules: hipaaRules.filter(rule => rule.control === '164.312(e)') },
    { id: '164.502(b)', name: 'Minimum Necessary', description: 'Limit PHI use and disclosure to necessary fields.', rules: hipaaRules.filter(rule => rule.control === '164.502(b)') },
  ],
}
