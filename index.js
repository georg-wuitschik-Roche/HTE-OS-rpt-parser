/**
 * Triggered from a change to a Cloud Storage bucket.
 * Many of the functions are asynchroneous (async keyword) allowing to force to wait during code execution for the output of a given function
 * @param {!Object} event Event payload.
 * @param {!Object} context Metadata for the event.
 */

var Recipient = "primary database"; // stirs into which database the contents of the rpt-files should flow and into which Google Space the chatmessages should go. 

exports.importRpt = async (event, context) => {
    //invoked if a new file is uploaded.
    const os = require("os");
    const fs = require("fs-extra");
    const path = require("path");
    const Storage = require("@google-cloud/storage");
    const storage = new Storage();

    // setting up variables

    const gcsEvent = event;
    const filePath = gcsEvent.name; //filename currently being processed
    console.log(`Processing file: ${gcsEvent.name}`);



    if (!filePath.includes(".rpt")) {
        sendChatMessage("File " + filePath + " doesn't have the file-extension rpt -> aborting now.");
        return;
    }

    const fileBucket = "rosl_rpt_storage"; //name of the filebucket being watched

    const bucket_fileName = path.basename(filePath);
    const bucket = storage.bucket(fileBucket); // file bucket object
    const workingDir = path.join(os.tmpdir(), "dataprocessing/"); // subdirectory of tmp for storing the content of the file temporarily

    const tempFilePath = path.join(workingDir, bucket_fileName);
    // all rpts that are uploaded to the folder "other database" or however you call it, are uploaded to a different database than those going elsewhere
    if (filePath.includes("other database")) { //switch the recipient, if the file should be imported to a different database (amend to suit your needs)
        Recipient = "other database";
        await createTcpPoolOtherDb(); // creates a connection pool that handles the individual SQL-Queries sent by iterate through samples
    } else {
        Recipient = "primary database";
        await createTcpPoolPrimaryDb(); // creates a connection pool that handles the individual SQL-Queries sent by iterate through samples
    }


    // await = only proceed once finished
    await fs.ensureDir(workingDir); // check whether the temporary directory exists and create it if it doesn't

    await bucket.file(filePath).download({ destination: tempFilePath }); //download the file into the temp location
    await fs.ensureFile(tempFilePath); // make sure the file exists

    const rptContent = fs.readFileSync(tempFilePath, "utf8"); // read the file into memory

    //split the content into individual SAMPLEs
    var sAMPLEsArray = rptContent.split("[SAMPLE]\r\n{");
    sAMPLEsArray.shift(); // removes the first element which is empty

    //Loop through the resulting arry of SAMPLEs and split out individual FUNCTION blocks ( TAC, ES+, ES-, 220 nm)
    //Wait for the iteration to be finished before proceeding
    try {
        chatMessage = await iterateThroughSamples(sAMPLEsArray, gcsEvent.name); // chatMessage is only returned once the upload of all data is finished. 
    }
    catch (err) {
        sendChatMessage("A serious error has occurred when processing " + gcsEvent.name + ", probably because the rpt-file is corrupted (premature end, Samplename-syntax not followed). Look at the rpt-file to figure out what's going on. This is the error: " + err + (new Error).stack); // send the results of the import into Google-Chat
        return;
    }

    fs.unlinkSync(tempFilePath); // delete the temporary file in the /tmp directory
    sendChatMessage(chatMessage); // send the results of the import into Google-Chat
    return;
};



// createTcpPool initializes a TCP connection pool for a Cloud SQL
// instance of SQL Server.
const createTcpPoolPrimaryDb = async config => {   //// connection is made to the Roche Screening Lab Database
    const sql = require("mssql");
    // Note: Saving credentials in environment variables is convenient, but not
    // secure - consider a more secure solution such as
    // Cloud Secret Manager (https://cloud.google.com/secret-manager) to help
    // keep secrets safe.
    const dbConfig = {
        server: "xx.yy.zzz.aa", // e.g. '127.0.0.1'
        port: 1433,
        user: "your username", // e.g. 'my-db-user', your user needs to have write privileges for the database
        password: "your password", // e.g. 'my-db-password'
        database: "your primary database", // e.g. 'my-database'
        options: {
            trustServerCertificate: true,
        },
        // ... Specify additional properties here.
        ...config,
    };
    return await sql.connect(dbConfig);
};

// createTcpPool initializes a TCP connection pool for a Cloud SQL
// instance of SQL Server.
const createTcpPoolOtherDb = async config => {   // connection is made to the Late-Stage Functionalization Database
    const sql = require("mssql");
    // Note: Saving credentials in environment variables is convenient, but not
    // secure - consider a more secure solution such as
    // Cloud Secret Manager (https://cloud.google.com/secret-manager) to help
    // keep secrets safe.
    const dbConfig = {
        server: "xx.yy.zzz.aa", // e.g. '127.0.0.1'
        port: 1433,
        user: "your username", // e.g. 'my-db-user', your user needs to have write privileges for the database
        password: "your password", // e.g. 'my-db-password'
        database: "your other database", // e.g. 'my-database'
        options: {
            trustServerCertificate: true,
        },
        // ... Specify additional properties here.
        ...config,
    };
    return await sql.connect(dbConfig);
};

function sendChatMessage(chatMessage) { //sends a Chatmessage to the rpt-rosl Google Space
    const fetch = require("node-fetch");
    var webhookURL = "";
    switch (Recipient) {
        case "primary database":
            webhookURL =
                "<<webhook to receive notifications after import is finished>>";                 // webhook in the RPT-Files Google Space by RoSL
            break;
        case "other database":
            webhookURL = "<<webhook to receive notifications after import is finished>>";   // webhook in the rpt Import - LSF Google Space by LSF
            break;
    }


    const data = JSON.stringify({
        text: chatMessage,
    });
    let resp;
    fetch(webhookURL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json; charset=UTF-8",
        },
        body: data,
    }).then((response) => {
        resp = response;

    });
    return resp;
}

// Takes in an array of samples and returns the peakTable ready for writing to the database

async function iterateThroughSamples(sAMPLEsArray, rptFileName) {
    return new Promise(async function (resolve, reject) {
        // returns a promise object that contains the peakTable once the function is finnished
        var peakDataArray = []; // these three arrays hold the respective data blocks returned from the readFUNCTION function
        var sampleDataArray = [];
        var msDataArray = [];
        var chatMessage = "";
        var sampleDatatemp = []; // temporarily holds the sample data which is identical for all function blocks that contain data (ES+-, TAC, 220nm), at the end pushed into sampleData
        var writeToDbfinished = "";
        var peakData = []; // these three arrays hold the respective data blocks to be returned to the calling main function
        var sampleData = [];
        var msData = [];
        var sampleNumber = 0;
        var sampleHeaderInfo = {};


        var sampleKeyArray = [];
        var peakKeyArray = [];
        var msKeyArray = [];




        try {
            for (sampleNumber = 0; sampleNumber < sAMPLEsArray.length; sampleNumber++) {
                // iterate through the array of all samples
                sAMPLEsArray[sampleNumber] = sAMPLEsArray[sampleNumber].split("}\r\n[FUNCTION]\r\n{\r\n"); //splits the text of each sample into the individual function blocks, the structure now looks like this: [[SampleHeader, Function 1, Function 2...], next Sample]
                // Next extract information out of the Sampleheader like the [COMPOUND] table and things like Samplename etc

                var temp = await readSAMPLEheader(sAMPLEsArray[sampleNumber][0]);
                sampleHeaderInfo = temp[0];
                compoundDictionary = temp[1]; // contains the masses and molecular formulas the MS was tasked to look for

                sAMPLEsArray[sampleNumber].shift(); // Remove the Sampleheader from each sub-array

                // Go through the individual function blocks and extract the information about the individual spectra from them.

                for (var functionBlock = 0; functionBlock < sAMPLEsArray[sampleNumber].length; functionBlock++) {
                    // go through the function blocks and read the information contained in them.

                    // hand each individual FUNCTION block to readFUNCTION() for parsing the content and append the array returned from readFUNCTION() to the three DataArrays
                    [sampleDataArray, peakDataArray, msDataArray] = await readFUNCTION(
                        //returns the sample- peak and ms-data as array
                        sAMPLEsArray[sampleNumber][functionBlock],
                        compoundDictionary,
                        sampleHeaderInfo
                    );

                    if (sampleDataArray.length > 0) {
                        // the function blocks before the 220 nm channel don't contain data in which cases an empty array is returned
                        sampleDatatemp = sampleDataArray[0];
                    }

                    if (peakDataArray.length > 0) {
                        // the function blocks before the 220 nm channel don't contain data in which cases an empty array is returned
                        for (var line = 0; line < peakDataArray.length; line++) {

                            if (peakKeyArray.indexOf(peakDataArray[line][0] + "_" + peakDataArray[line][1] + "_" + peakDataArray[line][2] + "_" + peakDataArray[line][3]) == -1) {// this makes sure that only the first occurrence of a duplicate line makes it to the final array
                                peakKeyArray.push(peakDataArray[line][0] + "_" + peakDataArray[line][1] + "_" + peakDataArray[line][2] + "_" + peakDataArray[line][3]); // go through the array and only include lines where the combination of Sample_ID, ELN_ID, PeakRef and PeakID is unique
                                peakData.push(peakDataArray[line].join(","));  // push the joined version of the line since its individual members aren't needed for the success chatmessage.
                            }
                        }
                    }
                    if (msDataArray.length > 0) {
                        // the function blocks before the 220 nm channel don't contain data in which cases an empty array is returned
                        for (var line = 0; line < msDataArray.length; line++) { // go through the array and only include lines where the combination of with respect to Sample_ID,  ELN_ID, PeakRef, PeakID, Description, Mass, Intensity is unique

                            if (msKeyArray.indexOf(msDataArray[line][0] + "_" + msDataArray[line][1] + "_" + msDataArray[line][2] + "_" + msDataArray[line][3] + "_" + msDataArray[line][4] + "_" + msDataArray[line][5]) == -1) {// this makes sure that only the first occurrence of a duplicate line makes it to the final array
                                msKeyArray.push(msDataArray[line][0] + "_" + msDataArray[line][1] + "_" + msDataArray[line][2] + "_" + msDataArray[line][3] + "_" + msDataArray[line][4] + "_" + msDataArray[line][5]);
                                msData.push(msDataArray[line].join(",")); // push the joined version of the line since its individual members aren't needed for the success chatmessage.
                            }


                        }
                    }
                }
                // Check if Sample_ID and ELN_ID are unique and only write if that's the case

                if (sampleKeyArray.indexOf(sampleDatatemp[3] + "_" + sampleDatatemp[4]) == -1) {// this makes sure that only the first occurrence of a duplicate line makes it to the final array
                    sampleKeyArray.push(sampleDatatemp[3] + "_" + sampleDatatemp[4]);
                    sampleData.push(sampleDatatemp); //push the unjoined version, since the success message needs members of the first line. 
                } else {
                    sendChatMessage(JSON.stringify(sampleDatatemp) + " is a duplicate entry with respect to Sample_ID and ELN_ID and is not imported to the database. This is a rare glitch happening during rpt-file generation in Waters Masslynx and leads to loss of all information of the duplicated sample. The sample which is kept is likely "
                        + JSON.stringify(sampleData[sampleData.length - 1] + "The one that is missing is likely the one that was measured afterwards, normally one row down."));
                }

            }

        }
        catch (err) {
            sendChatMessage("A serious error has occurred when processing " + JSON.stringify(sampleHeaderInfo) + ", probably because the rpt-file is corrupted (premature end, Samplename-syntax not followed). Look at the rpt-file to figure out what's going on. This is the error: " + err + (new Error).stack); // send the results of the import into Google-Chat
        }

        if (sampleNumber === sAMPLEsArray.length) { // true when the iteration through all samples is finished
            // at the end of the array the release of the results is triggered and thus ensured that all the data is read
            chatMessage =
                sampleData[0][3] +
                ", Plate " +
                sampleData[0][5] +
                ", Sample " +
                sampleData[0][6] +
                " ( " +
                sampleData[0][7] +
                ", " +
                rptFileName +
                ") was imported successfully ( " +
                sampleData.length +
                " samples in total). Blessed be the Lord!";
            writeToDbfinished = await writeToDb(peakData, sampleData, msData);

            if (sampleNumber === sAMPLEsArray.length && writeToDbfinished == "done") {

                resolve(chatMessage); // the promise is resolved and chatMessage returned
            } else if (writeToDbfinished == "problem") {
                resolve("Problem executing one of the database writes for " + sampleData[0][3] +
                    ", Plate " +
                    sampleData[0][5] +
                    ", Sample " +
                    sampleData[0][6] +
                    " ( " +
                    sampleData[0][7] +
                    ", " +
                    rptFileName +
                    ")");
            }
        }
    });
}

// writing the data of one sample to the database
async function writeToDb(peakTable, sampleTable, msTable) {
    return new Promise(async function (resolve, reject) {
        const sql = require("mssql");

        var peakTableSQLHeader = //header information for the data to be written to the peakdata table
            "INSERT INTO peakdata (ELN_ID, SAMPLE_ID, PEAK_ID, PEAK_REF, DESCRIPTION, ABS_AREA, AREA_BP, AREA_TOTAL, TIME_FIELD, HEIGHT, INTENSITY_1, INTENSITY_2, PEAK_1, PEAK_2, WIDTH) VALUES ( "; //sometimes the peaktable is written from a previous try, but not the other tables, thus ignore is used to ignore mistakes
        var peakTableSQL = "";
        var msTableSQLHeader = //header information for the data to be written to the msdata table
            "insert into msdata (ELN_ID, SAMPLE_ID, PEAK_ID, PEAK_REF, DESCRIPTION, MASS, INTENSITY, ASSIGNED_MOLECULAR_FORMULA ) values ("; // insert ignore is used, because mass is part of the primary key and it cannot be exluced that the sampe mass shows up in the same sample_id, peak_id, peak_ref, description combination
        var msTableSQL = "";
        var sampleTableSQL = //header information for the data to be written to the sampledata table
            "insert into sampledata (DATE_FIELD, INLETMETHOD, USERNAME, ELN_ID, SAMPLE_ID, PLATENUMBER, SAMPLENUMBER, RXNCONDITIONS, PLATEROW, PLATECOLUMN, LCMSSTRING) values ("; //ignore means that when the file is re-imported or an entry exists the corresponding value is ignored.
        var result2 = "";
        var result3 = "";
        var result = "";


        for (var line = 0; line < sampleTable.length; line++) {

            sampleTable[line] = sampleTable[line].join(",");

        }

        sampleTableSQL += sampleTable.join("),("); // Combine the header with the joined array in which each line is joined using ),(
        sampleTableSQL += ");"; //end of the query string
        try {
            result = await sql.query(sampleTableSQL);
        } catch (err) {
            sendChatMessage("An error has occurred while writing to the sampledata table of the db " + sampleTableSQL + ". Likely the database contains already the same sample (happens sometimes that it's duplicated in the rpt file). This is the error: " + err + (new Error).stack);
            resolve("problem");
        }


        try {
            for (lime = 0; lime < 500; lime++) {   // go through the peaktable and send the peaks in portions of 500 to the db. The + 500 doesn't really make sense, but it stops prematurely otherwise (peaktable.length a variable and influenced by the splicing?)
                peakTableSQL = "";
                peakTableSQL = peakTableSQLHeader;
                peakTableSQL += peakTable.splice(0, 950).join("),("); // Combine the header with the joined array in which each line is joined using ),(
                peakTableSQL += ");"; //end of the query string

                result2 = await sql.query(peakTableSQL); // returns a dictionary with several keys, among them rowsAffected: [xxx] number of rows written

                if (peakTable.length == 0) {//stop when the peakTable is empty
                    break;
                }

            }
        } catch (err) {
            sendChatMessage("An error has occurred while writing to the peakdata table of the db. " + peakTableSQL + "Likely the database contains already the same sample (happens sometimes that it's duplicated in the rpt file) or it's a collision where for the same sample ID, ELN ID, peak ID, peak Ref two peaks exist with the same mass. This is the error: " + err + (new Error).stack);
            resolve("problem");
        }

        try {
            for (lime = 0; lime < 500; lime++) {   //analogous to the sending of the peaktable

                msTableSQL = "";
                msTableSQL = msTableSQLHeader;
                msTableSQL += msTable.splice(0, 950).join("),("); // Combine the header with the joined array in which each line is joined using ),(
                msTableSQL += ");"; //end of the query string
                result3 = await sql.query(msTableSQL);
                if (msTable.length == 0) {// stop when everything is sent. 
                    break;
                }
            }

        } catch (err) {
            sendChatMessage("An error has occurred while writing to the msdata table of the db. " + msTableSQL + " Likely the database contains already the same sample (happens sometimes that it's duplicated in the rpt file) or it's a collision where for the same sample ID, ELN ID, peak ID, peak Ref two peaks exist with the same mass. This is the error: " + err + (new Error).stack);
            await sql.close();
            resolve("problem");
        }

        if (msTable.length == 0 && peakTable.length == 0) { // only resolve the promise when the arrays are empty, i.e. all lines have been sent to the database. 
            await sql.close();
            resolve("done");
        }
    });
}

//reads the individual function blocks (sections for ES+, ES-, TAC and 220 nm)
async function readFUNCTION(contentOfFunctionBlock, compoundDictionary, sampleHeaderInfo) {
    return new Promise(async function (resolve, reject) {
        // create a promise that resolves into the return value once the function is finished. Error handling via reject currently not used.

        var dESCRIPTION = ""; // Contains information on which type of function is analyzed, ends up in the DESCRIPTION field in the database.
        var peakDictionary = {}; // A dictionary is used to store the peak data, key is the Peak ID, value is another dictionary containing all data relevant for this peak ID as key/value pairs
        var sampleDataArray = []; // array of samples at the level of individual vial to be appended to the overall datatable sampledata
        var peakDataArray = []; // array of peaks to be appended to the overall datatable peakdata
        var msDataArray = []; // array of ms-Peaks and intensities at the peak level to be appended to the overall datatable msdata
        var tempMass = 0; // holds the mass retrieved from the peakDictionary in order to either add (ES-) or subtract (ES+) 1.01 (proton mass) from it
        // split the text block along the [CHROMATOGRAM] word:
        // - The first section will contain the headerinformation on what type it is as well as the combined MS-spectra [SPECTRUM] of each [PEAK] in case it is ES+ and ES-.
        // - The second section will contain the xy-[TRACE] (which we don't care about) as well as individual [PEAK]s, be it measured by UV-absorption or Total Ionisation Count.
        var functionBlockChromDivision = [];
        var tempStr = "";
        if (contentOfFunctionBlock.includes("[CHROMATOGRAM]\r\n{")) {

            functionBlockChromDivision = contentOfFunctionBlock.split("[CHROMATOGRAM]\r\n{");
            tempStr = functionBlockChromDivision[0].substring(0, 50);
            //figure out which kind function block it is: ES+, ES-, DAD (TAC) or 220 nm


            if (tempStr.includes("ES+")) {
                // the function block in question is from an MS-trace and thus contains MS-data to be extracted
                dESCRIPTION = "ES+";
            } else if (tempStr.includes("ES-")) {
                dESCRIPTION = "ES-";
            } else if (tempStr.includes("DAD")) {
                dESCRIPTION = "TAC";
            } else {
                //At this point it must be the 220 nm channel, because the empty function blocks were already excluded before
                dESCRIPTION = "220 nm";
            }

            try {
                // Analyze the rest of the function block depending on the type of trace (MS or UV)

                switch (dESCRIPTION) {
                    case "ES+": // only in case of MS-data, the first part of the functionBlockChromDivision will contain information on the MS-spectra which is needed to figure out the 5 most intense mass peaks and the observed molecular formula.
                    case "ES-":
                        var functionBlockSpectra = functionBlockChromDivision[0].split("\r\n[SPECTRUM]\r\n{\r\n");
                        functionBlockSpectra.shift(); //get rid of the stuff before the first [SPECTRUM]
                        peakDictionary = await readMsData(peakDictionary, functionBlockSpectra, compoundDictionary);
                    //no break statement because the MS-function blocks also contain a peak section
                    default: // analyze the second part of the functionBlockChromDivision which contains the individual peaks which has to be performed in any case
                        //get rid of the stuff before the first [PEAK]
                        // split the peak section into the individual peaks
                        var functionBlockPeaks = functionBlockChromDivision[1].split("}\r\n[PEAK]\r\n{\r\n");
                        functionBlockPeaks.shift();
                        peakDictionary = await readPeakData(peakDictionary, functionBlockPeaks);
                }
            }
            catch (err) { // send the error into Google-Chat
                sendChatMessage("A serious error has occurred in the readFUNCTION function " + JSON.stringify(sampleHeaderInfo) + "in this function block" + functionBlockChromDivision[0] + ", probably because the rpt-file is corrupted (premature end, Samplename-syntax not followed). Look at the rpt-file to figure out what's going on. This is the error: " + err + (new Error).stack);

            }


            var keyArray = Object.keys(peakDictionary);
            var currentKey = "";
            var sampleDescriptionParts = sampleHeaderInfo["SampleDescription"].split("_"); //Array of the different parts of the sample name, ELNID, Platenumber, Samplenumber...
            for (var key = 0; key < keyArray.length; key++) {
                // go through all of the peaks in peakDictionary and write the data into the arrays later to be sent to the different datatables
                // '-marks are needed for the construction of the sql string

                currentKey = keyArray[key];

                peakDataArray.push([
                    generateSqlValue(sampleDescriptionParts[0]), //ELN-ID
                    generateSqlValue(sampleHeaderInfo["SampleID"]),
                    generateSqlValue(peakDictionary[currentKey]["Peak ID"]),
                    generateSqlValue(peakDictionary[currentKey]["Peak Ref"]),
                    generateSqlValue(dESCRIPTION),
                    generateSqlValue(peakDictionary[currentKey]["AreaAbs"]),
                    generateSqlValue(peakDictionary[currentKey]["Area %BP"]),
                    generateSqlValue(peakDictionary[currentKey]["Area %Total"]),
                    generateSqlValue(peakDictionary[currentKey]["Time"]),

                    generateSqlValue(peakDictionary[currentKey]["Height"]),
                    generateSqlValue(peakDictionary[currentKey]["Intensity_1"]),
                    generateSqlValue(peakDictionary[currentKey]["Intensity_2"]),
                    generateSqlValue(peakDictionary[currentKey]["Peak_1"]),
                    generateSqlValue(peakDictionary[currentKey]["Peak_2"]),
                    generateSqlValue(peakDictionary[currentKey]["Width"]),
                ]);
                if (dESCRIPTION.substring(0, 2) == "ES") {
                    //only do that for ES+ and ES-
                    for (var mostAbundantMass = 1; mostAbundantMass < 6; mostAbundantMass++) {
                        if (peakDictionary[currentKey]["MOST_ABUNDANT_MASS_IN_PEAK_" + mostAbundantMass]) {
                            // this is clumsy, but the result of the old data structure in which everything was saved in one big table

                            if (dESCRIPTION.substring(0, 3) == "ES+") {
                                tempMass = peakDictionary[currentKey]["MOST_ABUNDANT_MASS_IN_PEAK_" + mostAbundantMass] - 1.01;
                            } else {
                                //ES-, thus the mass of a proton needs to be added in order to make the masses comparable later in Spotfire
                                tempMass = peakDictionary[currentKey]["MOST_ABUNDANT_MASS_IN_PEAK_" + mostAbundantMass] + 1.01;
                            }

                            msDataArray.push([
                                generateSqlValue(sampleDescriptionParts[0]), //ELN-ID
                                generateSqlValue(sampleHeaderInfo["SampleID"]),
                                generateSqlValue(peakDictionary[currentKey]["Peak ID"]),
                                generateSqlValue(peakDictionary[currentKey]["Peak Ref"]),
                                generateSqlValue(dESCRIPTION),
                                generateSqlValue(tempMass),
                                generateSqlValue(peakDictionary[currentKey]["INTENSITY_MS_PEAK_" + mostAbundantMass]),
                                generateSqlValue(""),
                            ]);
                        }
                    }

                    if (peakDictionary[currentKey]["ASSIGNED_MOLECULAR_FORMULA"]) {
                        // if a mass is found that was looked for, it's treated as an additional MS-peak with intensity 120, i.e. making sure it's big
                        msDataArray.push([
                            generateSqlValue(sampleDescriptionParts[0]), //ELN-ID
                            generateSqlValue(sampleHeaderInfo["SampleID"]),
                            generateSqlValue(peakDictionary[currentKey]["Peak ID"]),
                            generateSqlValue(peakDictionary[currentKey]["Peak Ref"]),
                            generateSqlValue(dESCRIPTION),
                            generateSqlValue(peakDictionary[currentKey]["OBSERVED_MASS_CONNECTED"]),
                            120, //arbitrarily chosen for the peak intensity, making sure that it's larger than the largest "normal" MS-Peak (limited to 100)
                            generateSqlValue(peakDictionary[currentKey]["ASSIGNED_MOLECULAR_FORMULA"]),
                        ]);
                    }
                }
            }

            if (key === keyArray.length) {
                var sampleIDparts = sampleHeaderInfo["SampleID"].split("-"); //Array of the different parts of the SampleID MS9-13478-02 --> [MS9, 13478, 02] = [Number of MS used, rpt-file number, sample number]...

                switch (String(sampleIDparts[1]).length) {  // adds number padding for rpt-file numbers < 10,000 in order to get the correct pdf-filename.
                    case 4:
                        sampleIDparts[1] = "0" + String(sampleIDparts[1]);
                        break;
                    case 3:
                        sampleIDparts[1] = "00" + String(sampleIDparts[1]);
                        break;
                    case 2:
                        sampleIDparts[1] = "000" + String(sampleIDparts[1]);
                        break;
                    case 1:
                        sampleIDparts[1] = "0000" + String(sampleIDparts[1]);
                        break;

                }


                var tempRow = generateSqlValue(sampleDescriptionParts[sampleDescriptionParts.length - 1][0]); //Row from A-H
                var tempColumn = parseInt(String(sampleDescriptionParts[sampleDescriptionParts.length - 1]).substring(1)); //guarantee that always the last element in the SampleDescription is the coordinate, thus making it robust against having too many _ .
                if (!Number.isInteger(tempColumn)) {
                    // check if it's an integer, because otherwise 'NaN' is written to the db
                    tempColumn = 0; // if for some reason, the sample name is messed up, write 0
                }
                var lcmsString = "'" +
                    String(sampleHeaderInfo["Date"]).substring(String(sampleHeaderInfo["Date"]).length - 4) +
                    "\\\\" + // double-escaped, turns into one \ when arriving in the sql db
                    sampleHeaderInfo["UserName"] +
                    "\\\\" +
                    sampleIDparts[0] +
                    "-" +
                    String(sampleHeaderInfo["Date"]).substring(
                        //last two digits of the current year
                        String(sampleHeaderInfo["Date"]).length - 2
                    ) +
                    "-" +
                    sampleIDparts[1] +
                    "-" +
                    sampleIDparts[2] +
                    "-" +
                    String(sampleHeaderInfo["SampleDescription"]) + //Sample name, e.g. ELN032036-174_2_1_3h105C_G2
                    "'";

                lcmsString = lcmsString.replaceAll('.', '_');    // . found in the sample description will be replaced by _ for the construction of the pdf file name
                lcmsString = lcmsString.replaceAll('+', '_');
                sampleDataArray = [
                    [
                        generateSqlValue(sampleHeaderInfo["Date"]), //e.g. 11-Jul-2022
                        generateSqlValue(sampleHeaderInfo["InletMethod"]), //e.g. plate_login
                        generateSqlValue(sampleHeaderInfo["UserName"]), // e.g. HTE_LAB
                        generateSqlValue(sampleDescriptionParts[0]), //ELN-ID
                        generateSqlValue(sampleHeaderInfo["SampleID"]), // e.g.  MS9-13478-02
                        parseInt(sampleDescriptionParts[1]), //Platenumber
                        parseInt(sampleDescriptionParts[2]), //Samplenumber
                        generateSqlValue(sampleDescriptionParts[3]), //RxnConditions
                        tempRow, // row from A-H;
                        tempColumn, //Column from 1-12
                        //  core of the LCMSLINK to location of the pdf-file, stays the same even if components of the sample description are changed afterward because of a typo.
                        //  e.g. \2022\HTE_LAB\MS9-22-12557-15-ELN032036-174_2_1_3h105C_G2
                        lcmsString,
                    ],
                ];
                resolve([sampleDataArray, peakDataArray, msDataArray]);
            } // once the end of the dictionary is reached, resolve the promise and return the peakTable
        } else {
            resolve([[], [], []]); //there are empty function blocks that don't have chromatogram sections before the 220 nm channel.
        }
    });
}

// reads the MS-data (most abundant peaks and intensities as well as whether a given peak contains a mass that was searched for) contained in the function blocks ES+ and ES-
async function readMsData(peakDictionary, functionBlockSpectra, compoundDictionary) {

    try {
        return new Promise(function (resolve, reject) {
            var currentPeakId = 999;
            var currentPeakRef = 999;
            var currentTime = 111;
            var massTable = []; // contains mass intensity pairs
            var resultsTable = []; // contains the assignments of molecular weight to molecular formula and whether it was found by the LCMS in a given SPECTRUM
            // create a promise that resolves into the return value once the function is finished. Error handling via reject currently not used.
            for (var block = 0; block < functionBlockSpectra.length; block++) {
                // go through the individual spectra and get out the data.
                if (functionBlockSpectra[block].includes("}\r\n[RESULTS]\r\n{\r\n")) {
                    // if masses are defined to be searched for there is a results-table contains the assignment which masses were found in a given peak.
                    functionBlockSpectra[block] = functionBlockSpectra[block].split("}\r\n[MS]\r\n{\r\n");
                    massTable = functionBlockSpectra[block][1]; // contains the [MS]-table with mass and intensity
                    massTable = massTable.split("\r\n"); //split by line break;
                    massTable.shift(); // remove the header line
                    functionBlockSpectra[block] = functionBlockSpectra[block][0].split("}\r\n[RESULTS]\r\n{\r\n");
                    resultsTable = functionBlockSpectra[block][1]; // contains the [RESULTS]-table identifying which mass was found
                    functionBlockSpectra[block] = functionBlockSpectra[block][0]; // Header section containing the Peak ID.

                    resultsTable = resultsTable.split("\r\n"); //split by line break;
                    resultsTable.shift(); // remove the header line
                    resultsTable.pop(); // last line only contains a bracket and is removed
                    for (var line = 0; line < resultsTable.length; line++) {
                        // split each line by tabulator
                        resultsTable[line] = resultsTable[line].split("\t");

                        if (resultsTable.length > 0) {
                            for (var element = 1; element < resultsTable[line].length - 1; element++) {
                                // the individual elements are interpreted as text, now corrected to be numbers. The last element is not a number, thus not parsed as float. The first element needs to stay as a string for looking up in the sampleDictionary: Otherwise if the mass ends in a 0, the digit is clipped and the keys don't match anymore.
                                resultsTable[line][element] = parseFloat(resultsTable[line][element]);
                            }
                        }

                        if (resultsTable[line][1] == "0") {
                            // the mass in question wasn't observed (is 1 if it is), thus the line is spliced out: https://love2dev.com/blog/javascript-remove-from-array/
                            resultsTable.splice(line, 1);
                            line--;
                        }
                    }
                } else {
                    // if no masses are defined to be searched for there is no results-table which triggers it to be set to an empty array.
                    resultsTable = []; // in this case there is no results table
                    functionBlockSpectra[block] = functionBlockSpectra[block].split("[MS]"); // since there's no RESULTS table, there's also no closing-bracket of it.
                    massTable = functionBlockSpectra[block][1]; // contains the [MS]-table with mass and intensity
                    functionBlockSpectra[block] = functionBlockSpectra[block][0]; //although there's no RESULTS-table, the mapping from the MS-split still needs to be performed.
                    massTable = massTable.split("\r\n");
                    massTable.shift(); // get rid of header line and empty lines at the beginning
                    massTable.shift();
                    massTable.shift();
                }
                //Split the text along line breaks
                if (functionBlockSpectra[block]) {
                    // not clear which case this covers
                    functionBlockSpectra[block] = functionBlockSpectra[block].split("\r\n");
                } else {
                    resolve(peakDictionary);
                }

                // Split along tabs
                for (var line = 0; line < 8; line++) {
                    functionBlockSpectra[block][line] = functionBlockSpectra[block][line].split("\t");
                    if (functionBlockSpectra[block][line][0] == "Peak ID") {
                        currentPeakId = functionBlockSpectra[block][line][1];
                    }
                    if (functionBlockSpectra[block][line][0] == "Peak Ref") {
                        currentPeakRef = parseInt(functionBlockSpectra[block][line][1]); // PeakRef needs to be parsed as integer, otherwise stored as string, not the case for peak ID
                    }

                    if (functionBlockSpectra[block][line][0] == "Time") {
                        currentTime = parseFloat(functionBlockSpectra[block][line][1]); // Get the retention time of that Spectrum, not all Spectra show up as peaks, thus this may an attribution algorithm alternative to using Peak ID

                        break; // Time is the last piece of information needed, the rest of the table isn't interesting (TIC etc)
                    }
                }
                for (var line = 0; line < massTable.length; line++) {
                    massTable[line] = massTable[line].split("\t");

                    if (massTable[line][0] == "}") {
                        //clip the final
                        massTable.pop();
                    } else {
                        massTable[line] = [parseFloat(massTable[line][0]), parseFloat(massTable[line][1])];
                    }
                }

                massTable.pop(); //remove a final line that contains a bracket

                massTable.sort(function (a, b) {
                    // sort by intensity, highest intensities end up at the end
                    //https://riptutorial.com/javascript/example/3443/sorting-multidimensional-array
                    return a[1] - b[1];
                });
                if (!(currentPeakId + "_" + currentPeakRef in peakDictionary)) {
                    // checks if the key exists already (usually not the case for MS, since this section is parsed first) and only creates the empty dictionary if it doesn't exist.
                    peakDictionary[currentPeakId + "_" + currentPeakRef] = {}; // Peak ID always comes first in that dictionary and serves as key for the dictionary, new dictionary is then filled with other data coming from this peak
                    //if there is no key, then either the [SPECTRUM] section didn't contain information for that particular Peak ID or it is a non-MS [FUNCTION] block. Thus, empty key-value pairs are generated for most abundant mass and observed mass / formula
                    peakDictionary[currentPeakId + "_" + currentPeakRef]["Peak ID"] = currentPeakId; //add key/value pairs for Peak ID and Peak Ref so that the peak can be correctly written to the database even in cases when no corresponding PEAK section exists.
                    peakDictionary[currentPeakId + "_" + currentPeakRef]["Peak Ref"] = currentPeakRef;
                    peakDictionary[currentPeakId + "_" + currentPeakRef]["Time"] = currentTime;
                }

                for (var mostAbundantMass = 1; mostAbundantMass < 6; mostAbundantMass++) {
                    if (massTable.length > 0) {
                        // if the masstable is too short, then there may not be a mass to populate the peakDictionary
                        massIntensityPair = massTable.pop();
                        peakDictionary[currentPeakId + "_" + currentPeakRef]["MOST_ABUNDANT_MASS_IN_PEAK_" + mostAbundantMass] =
                            parseFloat(massIntensityPair[0]);
                        peakDictionary[currentPeakId + "_" + currentPeakRef]["INTENSITY_MS_PEAK_" + mostAbundantMass] = Math.ceil(
                            massIntensityPair[1]
                        ); //rounded up to save space in db and since nobody cares
                    } else {
                        peakDictionary[currentPeakId + "_" + currentPeakRef]["MOST_ABUNDANT_MASS_IN_PEAK_" + mostAbundantMass] = "";
                    }
                }

                if (resultsTable.length > 1) {
                    //more than one mass was found, sort the array by % BPI and pick the one with higher % BPI, probably quite rare that this happens
                    resultsTable.sort(function (a, b) {
                        //https://riptutorial.com/javascript/example/3443/sorting-multidimensional-array
                        return a[2] - b[2];
                    });
                    tempStr = resultsTable.pop()[0]; //the mass of the formula that we looked for and that was found with the highest intensity

                    peakDictionary[currentPeakId + "_" + currentPeakRef]["OBSERVED_MASS_CONNECTED"] = parseFloat(tempStr);
                    if (tempStr in compoundDictionary) {
                        peakDictionary[currentPeakId + "_" + currentPeakRef]["ASSIGNED_MOLECULAR_FORMULA"] =
                            compoundDictionary[tempStr];
                    } else {
                        peakDictionary[currentPeakId + "_" + currentPeakRef]["ASSIGNED_MOLECULAR_FORMULA"] = "Error";
                    }
                } else if (resultsTable.length === 1) {
                    //only one formula was found in this peak
                    if (resultsTable[0][0] in compoundDictionary) {
                        peakDictionary[currentPeakId + "_" + currentPeakRef]["ASSIGNED_MOLECULAR_FORMULA"] =
                            compoundDictionary[resultsTable[0][0]];
                    } else {
                        peakDictionary[currentPeakId + "_" + currentPeakRef]["ASSIGNED_MOLECULAR_FORMULA"] = "Error";
                    }
                    peakDictionary[currentPeakId + "_" + currentPeakRef]["OBSERVED_MASS_CONNECTED"] = parseFloat(
                        resultsTable[0][0]
                    );
                } else {
                    // if no masses are defined to be searched for there is no results-table which triggers it to be set to an empty array or if no formula was found by the LCMS.
                    peakDictionary[currentPeakId + "_" + currentPeakRef]["ASSIGNED_MOLECULAR_FORMULA"] = "";
                    peakDictionary[currentPeakId + "_" + currentPeakRef]["OBSERVED_MASS_CONNECTED"] = "";
                }
            }
            if (block === functionBlockSpectra.length) {
                resolve(peakDictionary);
            } // resolves the promise and releases the peak Dictionary once the last MS-Spectrum was read.
        });
    }
    catch (err) {
        sendChatMessage("Error in readMsData function" + err + (new Error).stack); // send the results of the import into Google-Chat
        return;
    }

}

// reads the data of each peak
async function readPeakData(peakDictionary, functionBlockPeaks) {


    try {
        return new Promise(function (resolve, reject) {
            var currentPeakId = 1000;
            var currentPeakRef = 1000;
            for (var block = 0; block < functionBlockPeaks.length; block++) {
                //Split the text along line breaks
                functionBlockPeaks[block] = functionBlockPeaks[block].split("\r\n");
                // Split along tabs
                // predicate, needed to break the loop from within the switch statement
                for (var line = 0; line < functionBlockPeaks[block].length; line++) {
                    functionBlockPeaks[block][line] = functionBlockPeaks[block][line].split("\t");
                    if (functionBlockPeaks[block][line].length == 1) {
                        // some of the lines don't have a value
                        functionBlockPeaks[block][line].push(""); // some of the lines don't have a value
                    }

                    switch (
                    functionBlockPeaks[block][line][0] // only push the stuff that interests us into the dictionary
                    ) {
                        case "Peak ID":
                            currentPeakId = parseInt(functionBlockPeaks[block][line][1]); // saves the current PeakId in a temporary variable which won't change until entering the next [PEAK] block
                            break;

                        //no break at this point because for convenience sake the Peak ID is also saved in the sub-dictionary.
                        case "Peak Ref":
                            currentPeakRef = parseInt(functionBlockPeaks[block][line][1]);
                            if (!(currentPeakId + "_" + currentPeakRef in peakDictionary)) {
                                // checks if the key exists already (usually the case for MS, since this section is parsed first) and only creates the empty dictionary if it doesn't exist.
                                peakDictionary[currentPeakId + "_" + currentPeakRef] = {}; // Peak ID always comes first in that dictionary and serves as key for the dictionary, new dictionary is then filled with other data coming from this peak
                                //if there is no key, then either the [SPECTRUM] section didn't contain information for that particular Peak ID / Peak Ref combinarion or it is a non-MS [FUNCTION] block. Thus, empty key-value pairs are generated for most abundant mass and observed mass / formula
                                peakDictionary[currentPeakId + "_" + currentPeakRef]["MOST_ABUNDANT_MASS_IN_PEAK_1"] = "";
                                peakDictionary[currentPeakId + "_" + currentPeakRef]["MOST_ABUNDANT_MASS_IN_PEAK_2"] = "";
                                peakDictionary[currentPeakId + "_" + currentPeakRef]["MOST_ABUNDANT_MASS_IN_PEAK_3"] = "";
                                peakDictionary[currentPeakId + "_" + currentPeakRef]["MOST_ABUNDANT_MASS_IN_PEAK_4"] = "";
                                peakDictionary[currentPeakId + "_" + currentPeakRef]["MOST_ABUNDANT_MASS_IN_PEAK_5"] = "";
                                peakDictionary[currentPeakId + "_" + currentPeakRef]["INTENSITY_MS_PEAK__1"] = "";
                                peakDictionary[currentPeakId + "_" + currentPeakRef]["INTENSITY_MS_PEAK_2"] = "";
                                peakDictionary[currentPeakId + "_" + currentPeakRef]["INTENSITY_MS_PEAK_3"] = "";
                                peakDictionary[currentPeakId + "_" + currentPeakRef]["INTENSITY_MS_PEAK_4"] = "";
                                peakDictionary[currentPeakId + "_" + currentPeakRef]["INTENSITY_MS_PEAK_5"] = "";
                                if (!("ASSIGNED_MOLECULAR_FORMULA" in peakDictionary[currentPeakId + "_" + currentPeakRef])) {
                                    peakDictionary[currentPeakId + "_" + currentPeakRef]["ASSIGNED_MOLECULAR_FORMULA"] = "";
                                    peakDictionary[currentPeakId + "_" + currentPeakRef]["OBSERVED_MASS_CONNECTED"] = "";
                                }
                            }
                            peakDictionary[currentPeakId + "_" + currentPeakRef]["Peak ID"] = currentPeakId; // creates a key/value pair for "Peak ID", because Peak Ref isn't known before second iteration of the loop
                            peakDictionary[currentPeakId + "_" + currentPeakRef][functionBlockPeaks[block][line][0]] = parseInt(
                                functionBlockPeaks[block][line][1]
                            ); // creates a key/value pair like "Peak Ref" : 5
                            break;
                        case "Height":
                            peakDictionary[currentPeakId + "_" + currentPeakRef][functionBlockPeaks[block][line][0]] = Math.ceil(
                                functionBlockPeaks[block][line][1]
                            ); // creates a key/value pair like "Height" : 545332 rounded up
                            break;
                        case "Time":
                        case "AreaAbs":
                        case "Area %BP":
                        case "Area %Total":
                        case "Width":
                            peakDictionary[currentPeakId + "_" + currentPeakRef][functionBlockPeaks[block][line][0]] = parseFloat(
                                functionBlockPeaks[block][line][1]
                            ); // creates a key/value pair like "Peak Ref" : 5
                            break;

                        case "Peak": // these two categories have two values attached to it attached to the beginning and end of the peak
                            if (functionBlockPeaks[block][line].length == 2) {
                                // some of the lines may not have a second value (unlikely)
                                functionBlockPeaks[block][line].push("");
                            }
                            peakDictionary[currentPeakId + "_" + currentPeakRef][functionBlockPeaks[block][line][0] + "_1"] =
                                parseFloat(functionBlockPeaks[block][line][1]); //creates a key/value pair like "Peak_1" : 0.4343
                            peakDictionary[currentPeakId + "_" + currentPeakRef][functionBlockPeaks[block][line][0] + "_2"] =
                                parseFloat(functionBlockPeaks[block][line][2]); //creates a key/value pair like "Peak_2" : 0.5555
                            break;
                        case "Intensity":
                            if (functionBlockPeaks[block][line].length == 2) {
                                // some of the lines may not have a second value (unlikely)
                                functionBlockPeaks[block][line].push("");
                            }
                            peakDictionary[currentPeakId + "_" + currentPeakRef][functionBlockPeaks[block][line][0] + "_1"] = Math.ceil(
                                functionBlockPeaks[block][line][1]
                            ); //creates a key/value pair like "Intensity_1" : 5543 rounded up
                            peakDictionary[currentPeakId + "_" + currentPeakRef][functionBlockPeaks[block][line][0] + "_2"] = Math.ceil(
                                functionBlockPeaks[block][line][2]
                            ); //creates a key/value pair like "Intensity_2" : 6533 rounded up

                            break;
                        default:
                            break;
                    }
                }
            }
            if (block === functionBlockPeaks.length) {
                // resolve the promise and release the peakDictionary to the calling function once the loop is finished.
                resolve(peakDictionary);
            }
        });
    }
    catch (err) {
        sendChatMessage("Error in readPeakData function" + err + (new Error).stack); // send the results of the import into Google-Chat
        return;
    }
}

function generateSqlValue(dictValue) {
    // little helper function that parses the values in the dictionary and prepares them for writing to the db.
    // makes sure that if a value is empty the result in the peaktable is "NULL" and that strings get additional ' so that they're recognized by sql as strings.
    if (!dictValue) {
        //https://stackoverflow.com/questions/5515310/is-there-a-standard-function-to-check-for-null-undefined-or-blank-variables-in
        dictValue = "NULL";
    } else if (typeof dictValue === "string") {
        dictValue = "'" + dictValue + "'";
    }
    return dictValue;
}

async function readSAMPLEheader(sampleHeader) {
    //read the interesting bits of the SAMPLE header
    return new Promise(function (resolve, reject) {
        // create a promise that resolves into the return value once the function is finished. Error handling via reject currently not used.
        var sampleHeaderInfo = {};
        var compoundDictionary = {};

        //Split off the [COMPOUND] section:
        sampleHeader = sampleHeader.split("\r\n[COMPOUND]\r\n{\r\n");
        var compoundText = sampleHeader[1];
        sampleHeader = sampleHeader[0];

        //Split the text along line breaks
        compoundText = compoundText.split("\r\n");
        compoundText.shift(); // remove the header line: ;Mono Mass     Formula
        sampleHeader = sampleHeader.split("\r\n");

        // Split along tabs
        for (var line = 0; line < compoundText.length; line++) {
            compoundText[line] = compoundText[line].split("\t");
        }
        for (var line = 0; line < sampleHeader.length; line++) {
            sampleHeader[line] = sampleHeader[line].split("\t");
        }

        // Go through compoundText and write the formulas into the compoundDictionary

        for (var line = 0; line < compoundText.length; line++) {
            if (compoundText[line][0] == "}") {
                // end of the table is reached
                break;
            }
            // assigns the formula as value to the molecular weight as key (risky, because key may not be unique, but since the molecular weight has 4 after comma digits, the risk is limited and would anyway not make a difference using low-res MS)
            compoundDictionary[compoundText[line][0]] = compoundText[line][1];
        }

        // Go through the rest of the sampleHeader and fill the corresponding dictionary

        for (var line2 = 0; line2 < sampleHeader.length; line2++) {
            if (sampleHeader[line][0] == "}") {
                // end of the table is reached
                break;
            }
            // assigns the formula as value to the molecular weight as key (risky, because key may not be unique, but since the molecular weight has 4 after comma digits, the risk is limited and would anyway not make a difference using low-res MS)

            switch (
            sampleHeader[line2][0] // only push the stuff that interests us into the dictionary
            ) {
                case "Date":
                case "InletMethod":
                case "SampleDescription":
                case "SampleID":
                case "UserName":
                    if (sampleHeader[line2].length == 1) {
                        // some of the lines don't have a value
                        sampleHeader[line2].push("no value in rpt-file"); // some of the lines don't have a value
                    }
                    sampleHeaderInfo[sampleHeader[line2][0]] = sampleHeader[line2][1];
                    break;
                default:
                    break;
            }
        }
        if (line2 === sampleHeader.length) {
            resolve([sampleHeaderInfo, compoundDictionary]); // resolve the promise and release the peakDictionary to the calling function once the loop is finished.
        }
    });
}

