import {
    LocalWorkspace,
    ConcurrentUpdateError,
    StackAlreadyExistsError,
    StackNotFoundError
} from "@pulumi/pulumi/automation";
import * as cdn from "@pulumi/azure-native/cdn";
import * as resources from "@pulumi/azure-native/resources";
import * as storage from "@pulumi/azure-native/storage";
import * as pulumi from "@pulumi/pulumi";
import * as express from "express";

const projectName = "pulumi_over_http";

// this function defines our pulumi S3 static website in terms of the content that the caller passes in.
// this allows us to dynamically deploy websites based on user defined values from the POST body.
const createPulumiProgram = (content: string) => async () => {

    const resourceGroup = new resources.ResourceGroup("resourceGroup");

    const profile = new cdn.Profile("profile", {
      resourceGroupName: resourceGroup.name,
      sku: {
        name: cdn.SkuName.Standard_Microsoft,
      },
    });
    
    const storageAccount = new storage.StorageAccount("storageaccount", {
      enableHttpsTrafficOnly: true,
      kind: storage.Kind.StorageV2,
      resourceGroupName: resourceGroup.name,
      sku: {
        name: storage.SkuName.Standard_LRS,
      },
    });
    
    // Enable static website support
    const staticWebsite = new storage.StorageAccountStaticWebsite("staticWebsite", {
      accountName: storageAccount.name,
      resourceGroupName: resourceGroup.name,
      indexDocument: "index.html",
    //   error404Document: "404.html",
    });

    // here our HTML is defined based on what the caller curries in.
    const indexContent = content;

    // write our index.html into the site bucket
    new storage.Blob("index.html", {
        resourceGroupName: resourceGroup.name,
        accountName: storageAccount.name,
        containerName: staticWebsite.containerName,
        source: content,
        contentType: "text/html",
      })
    
    // Web endpoint to the website
    const staticEndpoint = storageAccount.primaryEndpoints.web;
    
    // Optionally, add a CDN.
    const endpointOrigin = storageAccount.primaryEndpoints.apply((ep) =>
      ep.web.replace("https://", "").replace("/", "")
    );
    const endpoint = new cdn.Endpoint("endpoint", {
      endpointName: storageAccount.name.apply((sa) => `cdn-endpnt-${sa}`),
      isHttpAllowed: false,
      isHttpsAllowed: true,
      originHostHeader: endpointOrigin,
      origins: [
        {
          hostName: endpointOrigin,
          httpsPort: 443,
          name: "origin-storage-account",
        },
      ],
      profileName: profile.name,
      queryStringCachingBehavior: cdn.QueryStringCachingBehavior.NotSet,
      resourceGroupName: resourceGroup.name,
    });
    
    // CDN endpoint to the website.
    // Allow it some time after the deployment to get ready.
     const cdnEndpoint = pulumi.interpolate`https://${endpoint.hostName}/`;
        
    return {
        websiteUrl: cdnEndpoint,
    };
};
// creates new sites
const createHandler: express.RequestHandler = async (req, res) => {
    const stackName = req.body.id;
    const content = req.body.content as string;
    try {
        // create a new stack
        const stack = await LocalWorkspace.createStack({
            stackName,
            projectName,
            // generate our pulumi program on the fly from the POST body
            program: createPulumiProgram(content),
        });
        await stack.setConfig("aws:region", { value: "us-west-2" });
        // deploy the stack, tailing the logs to console
        const upRes = await stack.up({ onOutput: console.info });
        res.json({ id: stackName, url: upRes.outputs.websiteUrl.value });
    } catch (e) {
        if (e instanceof StackAlreadyExistsError) {
            res.status(409).send(`stack "${stackName}" already exists`);
        } else {
            res.status(500).send(e);
        }
    }
};
// lists all sites
const listHandler: express.RequestHandler = async (req, res) => {
    try {
        // set up a workspace with only enough information for the list stack operations
        const ws = await LocalWorkspace.create({ projectSettings: { name: projectName, runtime: "nodejs" } });
        const stacks = await ws.listStacks();
        res.json({ ids: stacks.map(s => s.name) });
    } catch (e) {
        res.status(500).send(e);
    }
};
// gets info about a specific site
const getHandler: express.RequestHandler = async (req, res) => {
    const stackName = req.params.id;
    try {
        // select the existing stack
        const stack = await LocalWorkspace.selectStack({
            stackName,
            projectName,
            // don't need a program just to get outputs
            program: async () => { },
        });
        const outs = await stack.outputs();
        res.json({ id: stackName, url: outs.websiteUrl.value });
    } catch (e) {
        if (e instanceof StackNotFoundError) {
            res.status(404).send(`stack "${stackName}" does not exist`);
        } else {
            res.status(500).send(e);
        }
    }
};
// updates the content for an existing site
const updateHandler: express.RequestHandler = async (req, res) => {
    const stackName = req.params.id;
    const content = req.body.content as string;
    try {
        // select the existing stack
        const stack = await LocalWorkspace.selectStack({
            stackName,
            projectName,
            // generate our pulumi program on the fly from the POST body
            program: createPulumiProgram(content),
        });
        await stack.setConfig("aws:region", { value: "us-west-2" });
        // deploy the stack, tailing the logs to console
        const upRes = await stack.up({ onOutput: console.info });
        res.json({ id: stackName, url: upRes.outputs.websiteUrl.value });
    } catch (e) {
        if (e instanceof StackNotFoundError) {
            res.status(404).send(`stack "${stackName}" does not exist`);
        } else if (e instanceof ConcurrentUpdateError) {
            res.status(409).send(`stack "${stackName}" already has update in progress`)
        } else {
            res.status(500).send(e);
        }
    }
};
// deletes a site
const deleteHandler: express.RequestHandler = async (req, res) => {
    const stackName = req.params.id;
    try {
        // select the existing stack
        const stack = await LocalWorkspace.selectStack({
            stackName,
            projectName,
            // don't need a program for destroy
            program: async () => { },
        });
        // deploy the stack, tailing the logs to console
        await stack.destroy({ onOutput: console.info });
        await stack.workspace.removeStack(stackName);
        res.status(200).end();
    } catch (e) {
        if (e instanceof StackNotFoundError) {
            res.status(404).send(`stack "${stackName}" does not exist`);
        } else if (e instanceof ConcurrentUpdateError) {
            res.status(409).send(`stack "${stackName}" already has update in progress`)
        } else {
            res.status(500).send(e);
        }
    }
};
const ensurePlugins = async () => {
    const ws = await LocalWorkspace.create({});
    await ws.installPlugin("azure", "5.11.0");
};

// install necessary plugins once upon boot
ensurePlugins();

// configure express
const app = express();
app.use(express.json());

// setup our RESTful routes for our Site resource
app.post("/sites", createHandler);
app.get("/sites", listHandler);
app.get("/sites/:id", getHandler);
app.put("/sites/:id", updateHandler);
app.delete("/sites/:id", deleteHandler);

// start our http server
app.listen(1337, () => console.info("server running on :1337"));