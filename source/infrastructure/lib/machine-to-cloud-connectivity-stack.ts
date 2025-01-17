// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Aspects, Aws, CfnCondition, CfnMapping, CfnParameter, Fn, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ApiConstruct } from './backend/api';
import { ConnectionBuilderConstruct } from './backend/connection-builder';
import { CommonResourcesConstruct } from './common-resource/common-resources';
import { CustomResourcesConstruct } from './custom-resource/custom-resources';
import { KinesisDataStreamConstruct } from './data-flow/kinesis-data-stream';
import { SQSMessageConsumerConstruct } from './data-flow/sqs-message-consumer';
import { TimestreamConstruct } from './data-flow/timestream';
import { UiConstruct } from './frontend/ui';
import { GreengrassConstruct } from './greengrass/greengrass';
import { ConditionAspect } from '../utils/aspects';
import { addOutputs } from '../utils/utils';

export interface MachineToCloudConnectivityFrameworkProps extends StackProps {
  readonly solutionBucketName: string;
  readonly solutionId: string;
  readonly solutionName: string;
  readonly solutionVersion: string;
}

/**
 * Machine to Cloud Connectivity Framework main CDK Stack
 */
export class MachineToCloudConnectivityFrameworkStack extends Stack {
  private kinesisStreamName: string;

  constructor(scope: Construct, id: string, props: MachineToCloudConnectivityFrameworkProps) {
    super(scope, id, props);

    this.templateOptions.templateFormatVersion = '2010-09-09';

    const userEmail = new CfnParameter(this, 'UserEmail', {
      type: 'String',
      description: 'The user E-Mail to access the UI',
      allowedPattern: '^[_A-Za-z0-9-\\+]+(\\.[_A-Za-z0-9-]+)*@[A-Za-z0-9-]+(\\.[A-Za-z0-9]+)*(\\.[A-Za-z]{2,})$',
      constraintDescription: 'User E-Mail must be a valid E-Mail address.'
    });
    const loggingLevel = new CfnParameter(this, 'LoggingLevel', {
      type: 'String',
      description: 'The logging level of the Lambda functions and the UI',
      allowedValues: ['VERBOSE', 'DEBUG', 'INFO', 'WARN', 'ERROR'],
      default: 'ERROR'
    });
    const existingKinesisStreamNameParameter = new CfnParameter(this, 'ExistingKinesisStreamName', {
      type: 'String',
      description: 'The Kinesis Data Stream Name can be found in the Data streams in the Amazon Kinesis console.',
      allowedPattern: '[a-zA-Z0-9-_.]*',
      constraintDescription: 'Kinesis Stream Name should match the allowed pattern: [a-zA-Z0-9-_.]'
    });
    const existingTimestreamDatabaseNameParameter = new CfnParameter(this, 'ExistingTimestreamDatabaseName', {
      type: 'String',
      description: 'The Timestream Database Name can be found in the Databases in the Amazon Timestream console.',
      allowedPattern: '(^[a-zA-Z0-9-_.]{3,256}|^$)'
    });

    this.templateOptions.metadata = {
      'AWS::CloudFormation::Interface': {
        ParameterGroups: [
          {
            Label: { default: 'Required parameters' },
            Parameters: [loggingLevel.logicalId, userEmail.logicalId]
          },
          {
            Label: { default: '(Optional) Using your existing resources' },
            Parameters: [
              existingKinesisStreamNameParameter.logicalId,
              existingTimestreamDatabaseNameParameter.logicalId
            ]
          }
        ],
        ParameterLabels: {
          [loggingLevel.logicalId]: { default: '* Logging Level' },
          [userEmail.logicalId]: { default: '* Initial User Email' },
          [existingKinesisStreamNameParameter.logicalId]: {
            default: 'Name of the Existing Kinesis Data Stream'
          },
          [existingTimestreamDatabaseNameParameter.logicalId]: {
            default: 'Name of the Existing Timestream Database'
          }
        }
      }
    };

    const solutionMapping = new CfnMapping(this, 'Solution', {
      mapping: {
        Config: {
          SolutionId: props.solutionId,
          Version: props.solutionVersion,
          SendAnonymousUsage: 'Yes',
          S3Bucket: props.solutionBucketName,
          KeyPrefix: `${props.solutionName}/${props.solutionVersion}`
        }
      }
    });
    const sendAnonymousUsage = solutionMapping.findInMap('Config', 'SendAnonymousUsage');
    const solutionId = solutionMapping.findInMap('Config', 'SolutionId');
    const solutionVersion = solutionMapping.findInMap('Config', 'Version');
    const sourceCodeBucket = Fn.join('-', [solutionMapping.findInMap('Config', 'S3Bucket'), Aws.REGION]);
    const sourceCodePrefix = solutionMapping.findInMap('Config', 'KeyPrefix');

    const sendAnonymousUsageCondition = new CfnCondition(this, 'SendAnonymousUsage', {
      expression: Fn.conditionEquals(sendAnonymousUsage, 'Yes')
    });
    const createKinesisResourcesCondition = new CfnCondition(this, 'CreateKinesisResources', {
      expression: Fn.conditionEquals(existingKinesisStreamNameParameter.valueAsString, '')
    });

    const commonResources = new CommonResourcesConstruct(this, 'CommonResources', {
      sourceCodeBucket
    });

    const kinesisDataStream = new KinesisDataStreamConstruct(this, 'Kinesis', {
      s3LoggingBucket: commonResources.s3LoggingBucket
    });
    Aspects.of(kinesisDataStream).add(new ConditionAspect(createKinesisResourcesCondition));
    this.kinesisStreamName = Fn.conditionIf(
      createKinesisResourcesCondition.logicalId,
      kinesisDataStream.kinesisStreamName,
      existingKinesisStreamNameParameter.valueAsString
    ).toString();

    const customResources = new CustomResourcesConstruct(this, 'CustomResources', {
      cloudWatchLogsPolicy: commonResources.cloudWatchLogsPolicy,
      existingKinesisStream: existingKinesisStreamNameParameter.valueAsString,
      existingTimestreamDatabase: existingTimestreamDatabaseNameParameter.valueAsString,
      sendAnonymousUsageCondition,
      solutionConfig: {
        loggingLevel: loggingLevel.valueAsString,
        solutionId,
        solutionVersion,
        sourceCodeBucket: commonResources.sourceCodeBucket,
        sourceCodePrefix
      }
    });

    const timestream = new TimestreamConstruct(this, 'Timestream', {
      databaseName: existingTimestreamDatabaseNameParameter.valueAsString,
      solutionConfig: {
        loggingLevel: loggingLevel.valueAsString,
        solutionId,
        solutionVersion,
        sourceCodeBucket: commonResources.sourceCodeBucket,
        sourceCodePrefix
      }
    });

    const greengrassResources = new GreengrassConstruct(this, 'GreengrassResources', {
      kinesisStreamName: this.kinesisStreamName,
      s3LoggingBucket: commonResources.s3LoggingBucket,
      solutionConfig: {
        solutionId,
        solutionVersion,
        uuid: customResources.uuid
      },
      timestreamKinesisStreamArn: timestream.kinesisStreamArn
    });
    customResources.setupGreengrassV2({
      greengrassIoTPolicyName: greengrassResources.greengrassIoTPolicyName,
      greengrassV2ResourceBucket: greengrassResources.greengrassResourceBucket,
      iotCredentialsRoleArn: greengrassResources.iotCredentialsRoleArn,
      iotPolicyName: greengrassResources.iotPolicyName,
      iotRoleAliasName: greengrassResources.iotRoleAliasName
    });

    const sqsMessageConsumer = new SQSMessageConsumerConstruct(this, 'SQSMessageConsumer', {
      solutionConfig: {
        loggingLevel: loggingLevel.valueAsString,
        solutionId,
        solutionVersion,
        sourceCodeBucket: commonResources.sourceCodeBucket,
        sourceCodePrefix
      }
    });

    const connectionBuilder = new ConnectionBuilderConstruct(this, 'ConnectionBuilder', {
      cloudWatchLogsPolicy: commonResources.cloudWatchLogsPolicy,
      greengrassResourceBucket: greengrassResources.greengrassResourceBucket,
      iotCertificateArn: customResources.iotCertificateArn,
      iotEndpointAddress: customResources.iotDataAtsEndpoint,
      kinesisStreamName: this.kinesisStreamName,
      kinesisStreamForTimestreamName: timestream.kinesisStreamName,
      logsTableArn: sqsMessageConsumer.logsTable.tableArn,
      logsTableName: sqsMessageConsumer.logsTable.tableName,
      solutionConfig: {
        loggingLevel: loggingLevel.valueAsString,
        sendAnonymousUsage,
        solutionId,
        solutionVersion,
        sourceCodeBucket: commonResources.sourceCodeBucket,
        sourceCodePrefix,
        uuid: customResources.uuid
      }
    });

    const api = new ApiConstruct(this, 'Api', {
      connectionBuilderLambdaFunction: connectionBuilder.connectionBuilderLambdaFunction
    });
    connectionBuilder.connectionBuilderLambdaFunction.addEnvironment(
      'API_ENDPOINT',
      `${api.apiId}.execute-api.${Aws.REGION}.amazonaws.com`
    );

    const ui = new UiConstruct(this, 'Ui', {
      apiId: api.apiId,
      resourceBucket: greengrassResources.greengrassResourceBucket,
      s3LoggingBucket: commonResources.s3LoggingBucket,
      userEmail: userEmail.valueAsString
    });
    customResources.setupUi({
      apiEndpoint: api.apiEndpoint,
      identityPoolId: ui.identityPoolId,
      loggingLevel: loggingLevel.valueAsString,
      resourceS3Bucket: greengrassResources.greengrassResourceBucket,
      uiBucket: ui.uiBucket,
      userPoolId: ui.userPoolId,
      webClientId: ui.webClientId
    });

    addOutputs(this, [
      {
        id: 'ConnectionControlRequestTopic',
        description: 'IoT Topic where connection controls need to be submitted',
        value: 'm2c2/job/{connectionName}'
      },
      {
        id: 'DataBucket',
        description: 'Bucket where the connection telemetry data will be stored',
        value: kinesisDataStream.dataBucketName,
        condition: createKinesisResourcesCondition
      },
      {
        id: 'KinesisStream',
        description: 'The Kinesis Data Stream that sends Greengrass Stream Manager data',
        value: this.kinesisStreamName
      },
      {
        id: 'GreengrassResourceBucket',
        description:
          'Bucket where the Greengrass v2 resources including installation scripts and component artifacts will be stored',
        value: greengrassResources.greengrassResourceBucket.bucketName
      },
      {
        id: 'ConnectionMetadataTable',
        description: 'The DynamoDB table where the connections metadata will be stored',
        value: connectionBuilder.connectionTableName
      },
      {
        id: 'GreengrassCoreDevicesTable',
        description: 'The DynamoDB table where the Greengrass core devices will be stored',
        value: connectionBuilder.greengrassCoreDevicesTableName
      },
      {
        id: 'LogsTable',
        description: 'The DynamoDB table where the IoT topic info or error logs will be stored',
        value: sqsMessageConsumer.logsTable.tableName
      },
      {
        id: 'TimestreamDatabaseTable',
        description: 'The Timestream database and table where the data will be stored',
        value: timestream.timestreamDatabaseTable
      },
      {
        id: 'TimestreamKinesisStream',
        description: 'The Kinesis Data Stream that sends Greengrass Stream Manager data to Timestream',
        value: timestream.kinesisStreamName
      },
      {
        id: 'UUID',
        description: 'Solution UUID',
        value: customResources.uuid
      },
      {
        id: 'UIDomainName',
        description: 'The UI domain name',
        value: `https://${ui.cloudFrontDomainName}`
      }
    ]);
  }
}
