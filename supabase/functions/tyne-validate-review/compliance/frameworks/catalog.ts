import type { ComplianceControl, CompliancePolicy, ComplianceRule, ComplianceFramework } from '../types.ts'

type RuleInput = Omit<ComplianceRule, 'id' | 'impact' | 'remediation'> & {
  impact?: string
  remediation?: string
}

function rule(framework: ComplianceFramework, input: RuleInput): ComplianceRule {
  return {
    id: `${framework}-${input.control}-${input.title.replace(/\W+/g, '-').toUpperCase()}`,
    impact: input.impact || 'The reviewed change may weaken the referenced compliance control.',
    remediation: input.remediation || 'Add the missing safeguard and a focused regression test.',
    ...input,
  }
}

function control(id: string, name: string, description: string, rules: ComplianceRule[]): ComplianceControl {
  return { id, name, description, rules }
}

export const catalogPolicies: CompliancePolicy[] = [
  {
    id: 'SOC2',
    name: 'SOC 2',
    version: '2017 TSC',
    description: 'Trust Services Criteria for security, availability, and confidentiality.',
    controls: [
      control('CC6', 'Logical Access', 'Authentication, authorization, and least privilege.', [
        rule('SOC2', { control: 'CC6', title: 'Sensitive access lacks authorization', severity: 'high', dataTypes: ['PHI', 'PII', 'PCI', 'Financial', 'Credential'], requireAny: ['access', 'response'], missingAny: ['auth'] }),
      ]),
      control('CC7', 'Monitoring', 'Security event logging and monitoring.', [
        rule('SOC2', { control: 'CC7', title: 'Sensitive activity lacks audit monitoring', severity: 'high', dataTypes: ['PHI', 'PII', 'PCI', 'Financial', 'Credential'], requireAny: ['access', 'mutation'], missingAny: ['audit', 'monitoring'] }),
      ]),
      control('CC8', 'Change Management', 'Changes are tested and reviewed.', [
        rule('SOC2', { control: 'CC8', title: 'Risky data change has no test evidence', severity: 'medium', requireAny: ['mutation'], missingAny: ['tests'] }),
      ]),
      control('C1', 'Confidentiality', 'Confidential information is protected.', [
        rule('SOC2', { control: 'C1', title: 'Confidential data written to logs', severity: 'critical', blocking: true, dataTypes: ['PHI', 'PII', 'PCI', 'Financial', 'Credential'], requireAll: ['log'] }),
      ]),
    ],
  },
  {
    id: 'PCI_DSS',
    name: 'PCI DSS',
    version: '4.0.1',
    description: 'Controls for systems that store, process, or transmit cardholder data.',
    controls: [
      control('3.2.1', 'No Sensitive Authentication Data Storage', 'CVV and authentication data must not be stored.', [
        rule('PCI_DSS', { control: '3.2.1', title: 'CVV or card authentication data may be stored', severity: 'critical', confidence: 'high', blocking: true, dataTypes: ['PCI'], requireAny: ['storage', 'mutation'] }),
      ]),
      control('4.2.1', 'Secure Transmission', 'Protect cardholder data over open networks.', [
        rule('PCI_DSS', { control: '4.2.1', title: 'Payment data transmitted over HTTP', severity: 'critical', blocking: true, dataTypes: ['PCI'], requireAll: ['http'] }),
      ]),
      control('10.2', 'Logging Protection', 'Do not expose cardholder data in logs.', [
        rule('PCI_DSS', { control: '10.2', title: 'Cardholder data written to logs', severity: 'critical', blocking: true, dataTypes: ['PCI'], requireAll: ['log'] }),
      ]),
    ],
  },
  {
    id: 'GDPR',
    name: 'GDPR',
    version: '2016/679',
    description: 'European personal-data processing and privacy controls.',
    controls: [
      control('Art.5', 'Data Minimization', 'Personal data must be adequate, relevant, and limited.', [
        rule('GDPR', { control: 'Art.5', title: 'Response may expose excessive personal data', severity: 'high', dataTypes: ['PII'], requireAll: ['response'], minFields: 4 }),
      ]),
      control('Art.6-7', 'Lawful Basis and Consent', 'Processing requires a lawful basis and consent where applicable.', [
        rule('GDPR', { control: 'Art.6-7', title: 'Personal data processing lacks consent evidence', severity: 'high', dataTypes: ['PII'], requireAny: ['storage', 'mutation'], missingAny: ['consent'] }),
      ]),
      control('Art.17', 'Right to Erasure', 'Deletion flows must remove personal data.', [
        rule('GDPR', { control: 'Art.17', title: 'Account deletion lacks personal-data erasure', severity: 'high', dataTypes: ['PII'], requireAll: ['mutation'], missingAny: ['deletion'], patterns: ['delete account', 'delete user', 'remove user', 'close account'] }),
      ]),
      control('Art.20', 'Data Portability', 'Provide export capability for personal data.', [
        rule('GDPR', { control: 'Art.20', title: 'Data-portability flow lacks an export safeguard', severity: 'medium', dataTypes: ['PII'], requireAny: ['access'], missingAny: ['export'], patterns: ['data portability', 'download my data'] }),
      ]),
    ],
  },
  {
    id: 'ISO27001',
    name: 'ISO 27001',
    version: '2022',
    description: 'Information security management controls.',
    controls: [
      control('A.5.15', 'Access Control', 'Restrict access according to business requirements.', [
        rule('ISO27001', { control: 'A.5.15', title: 'Sensitive access lacks authorization', severity: 'high', dataTypes: ['PHI', 'PII', 'PCI', 'Financial', 'Credential'], requireAny: ['access', 'response'], missingAny: ['auth'] }),
      ]),
      control('A.8.24', 'Cryptography', 'Use cryptography to protect sensitive information.', [
        rule('ISO27001', { control: 'A.8.24', title: 'Sensitive data uses cleartext transport', severity: 'critical', blocking: true, dataTypes: ['PHI', 'PII', 'PCI', 'Financial', 'Credential'], requireAll: ['http'] }),
      ]),
      control('A.8.15', 'Logging', 'Produce and protect relevant event logs.', [
        rule('ISO27001', { control: 'A.8.15', title: 'Sensitive activity lacks logging', severity: 'high', dataTypes: ['PHI', 'PII', 'PCI', 'Financial'], requireAny: ['access', 'mutation'], missingAny: ['audit', 'monitoring'] }),
      ]),
    ],
  },
  {
    id: 'NIST_CSF',
    name: 'NIST Cybersecurity Framework',
    version: '2.0',
    description: 'Identify, Protect, Detect, Respond, and Recover cybersecurity outcomes.',
    controls: [
      control('PR.AA', 'Protect: Identity and Access', 'Manage identities, authentication, and access.', [
        rule('NIST_CSF', { control: 'PR.AA', title: 'Sensitive operation lacks access enforcement', severity: 'high', dataTypes: ['PHI', 'PII', 'PCI', 'Financial', 'Credential'], requireAny: ['access', 'mutation', 'response'], missingAny: ['auth'] }),
      ]),
      control('DE.CM', 'Detect: Continuous Monitoring', 'Monitor systems and events for adverse activity.', [
        rule('NIST_CSF', { control: 'DE.CM', title: 'Sensitive operation lacks monitoring', severity: 'high', dataTypes: ['PHI', 'PII', 'PCI', 'Financial'], requireAny: ['access', 'mutation'], missingAny: ['audit', 'monitoring'] }),
      ]),
      control('RS.MA', 'Respond: Incident Management', 'Runtime incident handling is outside changed-code evidence.', []),
      control('RC.RP', 'Recover: Recovery Planning', 'Backup and recovery configuration is outside changed-code evidence.', []),
    ],
  },
  {
    id: 'NIST_800_53',
    name: 'NIST SP 800-53',
    version: 'Rev. 5',
    description: 'Security and privacy controls for information systems.',
    controls: [
      control('AC-3', 'Access Enforcement', 'Enforce approved authorizations.', [
        rule('NIST_800_53', { control: 'AC-3', title: 'Missing authorization enforcement', severity: 'high', dataTypes: ['PHI', 'PII', 'PCI', 'Financial', 'Credential'], requireAny: ['access', 'response', 'mutation'], missingAny: ['auth'] }),
      ]),
      control('AU-2', 'Event Logging', 'Identify and log auditable events.', [
        rule('NIST_800_53', { control: 'AU-2', title: 'Auditable event lacks logging', severity: 'high', requireAny: ['access', 'mutation'], missingAny: ['audit'] }),
      ]),
      control('SC-8', 'Transmission Confidentiality', 'Protect transmitted information.', [
        rule('NIST_800_53', { control: 'SC-8', title: 'Sensitive transmission is not protected', severity: 'critical', blocking: true, dataTypes: ['PHI', 'PII', 'PCI', 'Financial', 'Credential'], requireAll: ['http'] }),
      ]),
      control('SI-10', 'Information Input Validation', 'Validate information inputs.', [
        rule('NIST_800_53', { control: 'SI-10', title: 'Data mutation lacks input validation', severity: 'high', requireAny: ['mutation'], missingAny: ['validation'] }),
      ]),
    ],
  },
  {
    id: 'FEDRAMP',
    name: 'FedRAMP',
    version: 'Rev. 5',
    description: 'US government cloud security controls based on NIST SP 800-53.',
    controls: [
      control('AC-3', 'Access Enforcement', 'Enforce government-cloud access policy.', [
        rule('FEDRAMP', { control: 'AC-3', title: 'Sensitive cloud operation lacks authorization', severity: 'critical', blocking: true, dataTypes: ['PHI', 'PII', 'PCI', 'Financial', 'Credential'], requireAny: ['access', 'response', 'mutation'], missingAny: ['auth'] }),
      ]),
      control('AU-2', 'Audit Events', 'Record security-relevant events.', [
        rule('FEDRAMP', { control: 'AU-2', title: 'Sensitive cloud operation lacks audit logging', severity: 'high', requireAny: ['access', 'mutation'], missingAny: ['audit'] }),
      ]),
      control('SC-8', 'Transmission Protection', 'Protect information in transit.', [
        rule('FEDRAMP', { control: 'SC-8', title: 'Cloud communication uses cleartext HTTP', severity: 'critical', blocking: true, requireAll: ['http'] }),
      ]),
      control('SI-4', 'System Monitoring', 'Monitor systems for attacks and indicators.', [
        rule('FEDRAMP', { control: 'SI-4', title: 'Sensitive operation lacks monitoring evidence', severity: 'high', requireAny: ['access', 'mutation'], missingAny: ['monitoring', 'audit'] }),
      ]),
    ],
  },
  {
    id: 'CCPA_CPRA',
    name: 'CCPA / CPRA',
    version: '2023',
    description: 'California consumer privacy and personal-information controls.',
    controls: [
      control('1798.100', 'Collection and Notice', 'Track collection and use of personal information.', [
        rule('CCPA_CPRA', { control: '1798.100', title: 'Personal-information collection lacks consent or notice evidence', severity: 'high', dataTypes: ['PII'], requireAny: ['storage', 'mutation'], missingAny: ['consent'] }),
      ]),
      control('1798.105', 'Right to Delete', 'Support deletion of consumer information.', [
        rule('CCPA_CPRA', { control: '1798.105', title: 'Consumer deletion flow lacks data erasure', severity: 'high', dataTypes: ['PII'], requireAll: ['mutation'], missingAny: ['deletion'], patterns: ['delete account', 'delete user', 'remove user', 'close account'] }),
      ]),
      control('1798.115', 'Disclosure Tracking', 'Track disclosures of personal information.', [
        rule('CCPA_CPRA', { control: '1798.115', title: 'Personal-information disclosure lacks audit tracking', severity: 'high', dataTypes: ['PII'], requireAll: ['response'], missingAny: ['audit'] }),
      ]),
    ],
  },
  {
    id: 'SOX',
    name: 'SOX',
    version: '2002',
    description: 'Financial reporting integrity, change management, and audit controls.',
    controls: [
      control('ITGC-AC', 'Financial Access Control', 'Restrict access to financial systems and records.', [
        rule('SOX', { control: 'ITGC-AC', title: 'Financial data access lacks authorization', severity: 'critical', blocking: true, dataTypes: ['Financial'], requireAny: ['access', 'response', 'mutation'], missingAny: ['auth'] }),
      ]),
      control('ITGC-AU', 'Audit Trail', 'Maintain traceable financial activity.', [
        rule('SOX', { control: 'ITGC-AU', title: 'Financial change lacks audit trail', severity: 'critical', blocking: true, dataTypes: ['Financial'], requireAny: ['mutation', 'storage'], missingAny: ['audit'] }),
      ]),
      control('ITGC-CM', 'Change Management', 'Test and approve financial-system changes.', [
        rule('SOX', { control: 'ITGC-CM', title: 'Financial change lacks approval or test evidence', severity: 'high', dataTypes: ['Financial'], requireAny: ['mutation'], missingAny: ['approval', 'tests'] }),
      ]),
      control('ITGC-IN', 'Data Integrity', 'Protect financial record integrity.', [
        rule('SOX', { control: 'ITGC-IN', title: 'Financial mutation lacks validation or transaction protection', severity: 'critical', blocking: true, dataTypes: ['Financial'], requireAny: ['mutation', 'storage'], missingAny: ['validation', 'transaction'] }),
      ]),
    ],
  },
]
