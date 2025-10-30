// Shared DynamoDB GSI domain model used by both the CDK construct layer and the Lambda runtime.

export type AttributeTypeCode = "S" | "N" | "B";
export type ProjectionType = "ALL" | "KEYS_ONLY" | "INCLUDE";
export type GSIOperationType = "CREATE" | "UPDATE" | "DELETE";

export interface AttributeDefinition {
  name: string;
  type: AttributeTypeCode;
}

export interface ProvisionedThroughput {
  readCapacityUnits: number;
  writeCapacityUnits: number;
}

export interface GSIConfiguration {
  indexName: string;
  partitionKey: AttributeDefinition;
  sortKey?: AttributeDefinition;
  projectionType?: ProjectionType;
  nonKeyAttributes?: string[];
  provisionedThroughput?: ProvisionedThroughput;
}

export interface GSIInfo {
  indexName: string;
  keySchema: Array<{ attributeName: string; keyType: "HASH" | "RANGE" }>;
  projection: {
    projectionType: ProjectionType;
    nonKeyAttributes?: string[];
  };
  indexStatus?: string;
  provisionedThroughput?: ProvisionedThroughput;
}

export interface GSIManagerProps {
  tableName: string;
  globalSecondaryIndexes: GSIConfiguration[];
  errorHandling?: Partial<ErrorHandlingConfig>;
}

export interface GSIOperation {
  type: GSIOperationType;
  indexName: string;
  desiredConfiguration?: GSIConfiguration;
  currentConfiguration?: GSIInfo;
}

export interface GSIOperationPlan {
  operations: GSIOperation[];
}

export interface GSIOperationResult {
  success: boolean;
  operation: GSIOperationType;
  indexName: string;
  message?: string;
}

export interface ErrorHandlingConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableErrorCodes: string[];
}

export const VALID_ATTRIBUTE_TYPES: AttributeTypeCode[] = ["S", "N", "B"];
export const VALID_PROJECTION_TYPES: ProjectionType[] = [
  "ALL",
  "KEYS_ONLY",
  "INCLUDE",
];

export const DEFAULT_ERROR_CONFIG: ErrorHandlingConfig = {
  maxRetries: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  retryableErrorCodes: [
    "ThrottlingException",
    "ProvisionedThroughputExceededException",
    "ResourceInUseException",
  ],
};

export function validateGsiConfigurations(
  configurations: GSIConfiguration[]
): string[] {
  const issues: string[] = [];
  const seenNames = new Set<string>();

  configurations.forEach((config, index) => {
    if (!config.indexName?.trim()) {
      issues.push(`GSI at position ${index} is missing indexName.`);
    } else if (seenNames.has(config.indexName)) {
      issues.push(`GSI "${config.indexName}" is defined more than once.`);
    } else {
      seenNames.add(config.indexName);
    }

    const checkAttribute = (
      attribute: AttributeDefinition | undefined,
      role: "partitionKey" | "sortKey"
    ) => {
      if (!attribute) {
        if (role === "partitionKey") {
          issues.push(`GSI "${config.indexName}" does not define partitionKey.`);
        }
        return;
      }

      if (!attribute.name?.trim()) {
        issues.push(
          `GSI "${config.indexName}" ${role} is missing attribute name.`
        );
      }

      if (!VALID_ATTRIBUTE_TYPES.includes(attribute.type)) {
        issues.push(
          `GSI "${config.indexName}" ${role} has invalid type "${attribute.type}".`
        );
      }
    };

    checkAttribute(config.partitionKey, "partitionKey");
    checkAttribute(config.sortKey, "sortKey");

    if (
      config.projectionType &&
      !VALID_PROJECTION_TYPES.includes(config.projectionType)
    ) {
      issues.push(
        `GSI "${config.indexName}" has invalid projectionType "${config.projectionType}".`
      );
    }
  });

  return issues;
}

export function mergeErrorHandlingConfig(
  override?: Partial<ErrorHandlingConfig>
): ErrorHandlingConfig {
  if (!override) {
    return { ...DEFAULT_ERROR_CONFIG };
  }

  return {
    maxRetries:
      override.maxRetries ?? DEFAULT_ERROR_CONFIG.maxRetries,
    baseDelayMs:
      override.baseDelayMs ?? DEFAULT_ERROR_CONFIG.baseDelayMs,
    maxDelayMs:
      override.maxDelayMs ?? DEFAULT_ERROR_CONFIG.maxDelayMs,
    retryableErrorCodes:
      override.retryableErrorCodes ??
      [...DEFAULT_ERROR_CONFIG.retryableErrorCodes],
  };
}
