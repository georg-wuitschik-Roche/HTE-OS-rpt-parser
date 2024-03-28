# rpt-parser



## Getting started

Everything you need to get the import of rpt-files into a database running as a Google Cloud Function that is triggered when a new rpt-file is uploaded to the pre-determined Google Cloud Bucket. 

In order to adapt it to your environment, you need to specify:
- the Google Cloud Bucket that receives the rpt-files (happens when setting up the Google Cloud function when choosing "On (finalizing/creating) file in the selected bucket" as the event type that triggers the execution of the function). The name of the bucket has to be assigned to the const fileBucket in line 31
- the login information of the database where the data should end up in the const dbConfig. Since there is the option to write to different databases depending on the sub-folder where the rpt-file is located, this const has to be set for each database location. Note that you need to connect to the private IP of the database which you have to configure first (https://cloud.google.com/sql/docs/sqlserver/configure-private-ip). 
- the [webhook-URLs](https://developers.google.com/chat/how-tos/webhooks#step_1_register_the_incoming_webhook) ( var webhookURL) of the Google Chat Spaces that should receive notifications on imports. 
- if you have a backup server that contains the pdfs of all samples at a predictable path, then you'll most likely have to adapt how that path looks like. The path is stored under the var LCMSSTRING and looks like this for us: 2020\\wuitschg\\MS1-20-11962-04-ELN029554-012_3_2_D1 Server name and .pdf ending is added in Spotfire.  

## Structure of the datatables to which the content of the rpt-file is written

Three datatables need to exist in each receiving database:
- sampleData holding all information unique for each sample (e.g. samplename, aquisition method)
- peakData holding all information unique for each peak (e.g. retention time, peak area) in a given sample
- msData holding information on the five most intense peaks in ES+ and ES- that belongs to a given peak (mass, mass intensity and molecular formula of peak it's assigned to)

## Strings for generating the datatables

We're using MS SQL Server, you may have to adapt the generation strings (and the script writing tags out of Spotfire), if you want to use something else.

The foreign key classification in combination with cascading delete makes it easier to delete samples: It's sufficient to delete the samples from the sampledata table. All information from peakdata and msData pertaining to these samples will be deleted automatically.  

### sampleData

CREATE TABLE [dbo].[sampledata] (
    [DATE_FIELD]    VARCHAR (15)  NULL,
    [INLETMETHOD]   VARCHAR (50)  NULL,
    [USERNAME]      VARCHAR (15)  NULL,
    [ELN_ID]        VARCHAR (20)  NOT NULL,
    [SAMPLE_ID]     VARCHAR (100) NOT NULL,
    [PLATENUMBER]   INT           NULL,
    [SAMPLENUMBER]  INT           NULL,
    [RXNCONDITIONS] VARCHAR (40)  NULL,
    [PLATEROW]      VARCHAR (1)   NULL,
    [PLATECOLUMN]   TINYINT       NULL,
    [LCMSSTRING]    VARCHAR (100) NULL,
    CONSTRAINT [PK__sampleda__A8B3DE87192D0A8D] PRIMARY KEY CLUSTERED ([ELN_ID] ASC, [SAMPLE_ID] ASC)
);

### peakData

CREATE TABLE [dbo].[peakdata] (
    [ELN_ID]      VARCHAR (20)  NOT NULL,
    [SAMPLE_ID]   VARCHAR (100) NOT NULL,
    [PEAK_ID]     TINYINT       NOT NULL,
    [PEAK_REF]    SMALLINT      NOT NULL,
    [DESCRIPTION] VARCHAR (50)  NULL,
    [ABS_AREA]    REAL          NULL,
    [AREA_BP]     REAL          NULL,
    [AREA_TOTAL]  REAL          NULL,
    [TIME_FIELD]  FLOAT (53)    NULL,
    [HEIGHT]      INT           NULL,
    [INTENSITY_1] INT           NULL,
    [INTENSITY_2] INT           NULL,
    [PEAK_1]      REAL          NULL,
    [PEAK_2]      REAL          NULL,
    [WIDTH]       REAL          NULL,
    [COMPOUND]    VARCHAR (150) NULL,
    [Outlier]     BIT           NULL,
    CONSTRAINT [PK__peakdata__2A34D7247B67B301] PRIMARY KEY CLUSTERED ([ELN_ID] ASC, [SAMPLE_ID] ASC, [PEAK_REF] ASC, [PEAK_ID] ASC),
    CONSTRAINT [FK_peakdata_sampledata] FOREIGN KEY ([ELN_ID], [SAMPLE_ID]) REFERENCES [dbo].[sampledata] ([ELN_ID], [SAMPLE_ID]) ON DELETE CASCADE ON UPDATE CASCADE
);

### msData

CREATE TABLE [dbo].[msdata] (
    [ELN_ID]                     VARCHAR (20)  NOT NULL,
    [SAMPLE_ID]                  VARCHAR (100) NOT NULL,
    [PEAK_REF]                   SMALLINT      NOT NULL,
    [PEAK_ID]                    TINYINT       NOT NULL,
    [DESCRIPTION]                VARCHAR (50)  NOT NULL,
    [MASS]                       REAL          NOT NULL,
    [INTENSITY]                  TINYINT       NOT NULL,
    [ASSIGNED_MOLECULAR_FORMULA] VARCHAR (50)  NULL,
    CONSTRAINT [PK__msdata__2F423A9B34A440D0] PRIMARY KEY CLUSTERED ([ELN_ID] ASC, [SAMPLE_ID] ASC, [PEAK_REF] ASC, [PEAK_ID] ASC, [DESCRIPTION] ASC, [MASS] ASC, [INTENSITY] ASC),
    CONSTRAINT [FK_msdata_peakdata] FOREIGN KEY ([ELN_ID], [SAMPLE_ID], [PEAK_REF], [PEAK_ID]) REFERENCES [dbo].[peakdata] ([ELN_ID], [SAMPLE_ID], [PEAK_REF], [PEAK_ID]) ON DELETE CASCADE ON UPDATE CASCADE
);
